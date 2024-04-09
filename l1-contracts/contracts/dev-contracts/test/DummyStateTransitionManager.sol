// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import {StateTransitionManager} from "../../state-transition/StateTransitionManager.sol";

/// @title DummyExecutor
/// @notice A test smart contract implementing the IExecutor interface to simulate Executor behavior for testing purposes.
contract DummyStateTransitionManager is StateTransitionManager {
    // add this to be excluded from coverage report
    function test() internal virtual {}

    /// @notice Constructor
    constructor() StateTransitionManager(address(0)) {}

    function setHyperchain(uint256 _chainId, address _hyperchain) external {
        hyperchain[_chainId] = _hyperchain;
    }
}
