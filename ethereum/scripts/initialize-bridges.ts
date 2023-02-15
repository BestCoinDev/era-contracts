import { Command } from 'commander';
import { ethers, Wallet } from 'ethers';
import { Deployer } from '../src.ts/deploy';
import { formatUnits, parseUnits } from 'ethers/lib/utils';
import {
    computeL2Create2Address,
    web3Provider,
    hashL2Bytecode,
    applyL1ToL2Alias,
    getNumberFromEnv,
    DEFAULT_L2_GAS_PRICE_PER_PUBDATA
} from './utils';

import * as fs from 'fs';
import * as path from 'path';

const provider = web3Provider();
const testConfigPath = path.join(process.env.ZKSYNC_HOME as string, `etc/test_config/constant`);
const ethTestConfig = JSON.parse(fs.readFileSync(`${testConfigPath}/eth.json`, { encoding: 'utf-8' }));

const contractArtifactsPath = path.join(process.env.ZKSYNC_HOME as string, 'contracts/zksync/artifacts-zk/');

const l2BridgeArtifactsPath = path.join(contractArtifactsPath, 'cache-zk/solpp-generated-contracts/bridge/');

const openzeppelinTransparentProxyArtifactsPath = path.join(
    contractArtifactsPath,
    '@openzeppelin/contracts/proxy/transparent/'
);
const openzeppelinBeaconProxyArtifactsPath = path.join(contractArtifactsPath, '@openzeppelin/contracts/proxy/beacon');

function readBytecode(path: string, fileName: string) {
    return JSON.parse(fs.readFileSync(`${path}/${fileName}.sol/${fileName}.json`, { encoding: 'utf-8' })).bytecode;
}

function readInterface(path: string, fileName: string) {
    const abi = JSON.parse(fs.readFileSync(`${path}/${fileName}.sol/${fileName}.json`, { encoding: 'utf-8' })).abi;
    return new ethers.utils.Interface(abi);
}

const L2_ERC20_BRIDGE_PROXY_BYTECODE = readBytecode(
    openzeppelinTransparentProxyArtifactsPath,
    'TransparentUpgradeableProxy'
);
const L2_ERC20_BRIDGE_IMPLEMENTATION_BYTECODE = readBytecode(l2BridgeArtifactsPath, 'L2ERC20Bridge');
const L2_STANDARD_ERC20_IMPLEMENTATION_BYTECODE = readBytecode(l2BridgeArtifactsPath, 'L2StandardERC20');
const L2_STANDARD_ERC20_PROXY_BYTECODE = readBytecode(openzeppelinBeaconProxyArtifactsPath, 'BeaconProxy');
const L2_STANDARD_ERC20_PROXY_FACTORY_BYTECODE = readBytecode(
    openzeppelinBeaconProxyArtifactsPath,
    'UpgradeableBeacon'
);
const L2_ERC20_BRIDGE_INTERFACE = readInterface(l2BridgeArtifactsPath, 'L2ERC20Bridge');

async function main() {
    const program = new Command();

    program.version('0.1.0').name('initialize-bridges');

    program
        .option('--private-key <private-key>')
        .option('--gas-price <gas-price>')
        .option('--nonce <nonce>')
        .action(async (cmd) => {
            const deployWallet = cmd.privateKey
                ? new Wallet(cmd.privateKey, provider)
                : Wallet.fromMnemonic(
                      process.env.MNEMONIC ? process.env.MNEMONIC : ethTestConfig.mnemonic,
                      "m/44'/60'/0'/0/0"
                  ).connect(provider);
            console.log(`Using deployer wallet: ${deployWallet.address}`);

            const gasPrice = cmd.gasPrice ? parseUnits(cmd.gasPrice, 'gwei') : await provider.getGasPrice();
            console.log(`Using gas price: ${formatUnits(gasPrice, 'gwei')} gwei`);

            const nonce = cmd.nonce ? parseInt(cmd.nonce) : await deployWallet.getTransactionCount();
            console.log(`Using nonce: ${nonce}`);

            const deployer = new Deployer({
                deployWallet,
                governorAddress: deployWallet.address,
                verbose: true
            });

            const zkSync = deployer.zkSyncContract(deployWallet);
            const erc20Bridge = deployer.defaultERC20Bridge(deployWallet);

            const priorityTxMaxGasLimit = getNumberFromEnv('CONTRACTS_PRIORITY_TX_MAX_GAS_LIMIT');
            const governorAddress = await zkSync.getGovernor();
            const abiCoder = new ethers.utils.AbiCoder();

            const l2ERC20BridgeImplAddr = computeL2Create2Address(
                applyL1ToL2Alias(erc20Bridge.address),
                L2_ERC20_BRIDGE_IMPLEMENTATION_BYTECODE,
                '0x',
                ethers.constants.HashZero
            );

            const proxyInitializationParams = L2_ERC20_BRIDGE_INTERFACE.encodeFunctionData('initialize', [
                erc20Bridge.address,
                hashL2Bytecode(L2_STANDARD_ERC20_PROXY_BYTECODE),
                governorAddress
            ]);
            const l2ERC20BridgeProxyAddr = computeL2Create2Address(
                applyL1ToL2Alias(erc20Bridge.address),
                L2_ERC20_BRIDGE_PROXY_BYTECODE,
                ethers.utils.arrayify(
                    abiCoder.encode(
                        ['address', 'address', 'bytes'],
                        [l2ERC20BridgeImplAddr, governorAddress, proxyInitializationParams]
                    )
                ),
                ethers.constants.HashZero
            );

            const l2StandardToken = computeL2Create2Address(
                l2ERC20BridgeProxyAddr,
                L2_STANDARD_ERC20_IMPLEMENTATION_BYTECODE,
                '0x',
                ethers.constants.HashZero
            );
            const l2TokenFactoryAddr = computeL2Create2Address(
                l2ERC20BridgeProxyAddr,
                L2_STANDARD_ERC20_PROXY_FACTORY_BYTECODE,
                ethers.utils.arrayify(abiCoder.encode(['address'], [l2StandardToken])),
                ethers.constants.HashZero
            );

            const independentInitialization = [
                zkSync.requestL2Transaction(
                    ethers.constants.AddressZero,
                    0,
                    '0x',
                    priorityTxMaxGasLimit,
                    DEFAULT_L2_GAS_PRICE_PER_PUBDATA,
                    [L2_STANDARD_ERC20_PROXY_FACTORY_BYTECODE, L2_STANDARD_ERC20_IMPLEMENTATION_BYTECODE],
                    deployWallet.address,
                    { gasPrice, nonce }
                ),
                erc20Bridge.initialize(
                    [
                        L2_ERC20_BRIDGE_IMPLEMENTATION_BYTECODE,
                        L2_ERC20_BRIDGE_PROXY_BYTECODE,
                        L2_STANDARD_ERC20_PROXY_BYTECODE
                    ],
                    l2TokenFactoryAddr,
                    governorAddress,
                    {
                        gasPrice,
                        nonce: nonce + 1
                    }
                )
            ];

            const txs = await Promise.all(independentInitialization);
            const receipts = await Promise.all(txs.map((tx) => tx.wait()));

            console.log(`ERC20 bridge initialized, gasUsed: ${receipts[1].gasUsed.toString()}`);
            console.log(`CONTRACTS_L2_ERC20_BRIDGE_ADDR=${await erc20Bridge.l2Bridge()}`);
        });

    await program.parseAsync(process.argv);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Error:', err);
        process.exit(1);
    });
