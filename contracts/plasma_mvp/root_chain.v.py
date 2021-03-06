struct ChildChainBlock:
    root: bytes32
    blockTimestamp: timestamp

struct Exit:
    owner: address
    token: address
    amount: uint256

contract PriorityQueue():
    def setup() -> bool: modifying
    def insert(_k: uint256) -> bool: modifying 
    def getMin() -> uint256: constant
    def delMin() -> uint256: modifying
    def getCurrentSize() -> uint256: constant

Deposit: event({_depositor: indexed(address), _depositBlock: indexed(uint256), _token: address, _amount: uint256(wei)})
ExitStarted: event({_exitor: indexed(address), _utxoPos: indexed(uint256), _token: address, _amount: uint256})
BlockSubmitted: event({_root: bytes32, _timestamp: timestamp})
TokenAdded: event({_token: address})

childChain: map(uint256, ChildChainBlock)


exits: map(uint256, Exit)

exitsQueues: map(address, address)

operator: address
currentChildBlock: uint256
currentDepositBlock: uint256
currentFeeExit: uint256


#
# Library
#

@private
@constant
def createExitingTx(_exitingTxBytes: bytes[1024], _oIndex: uint256) -> (address, address, uint256, uint256):    
    assert(_oIndex == 0 or _oIndex == 1)
    # TxField: [blkbum1, txindex1, oindex1, blknum2, txindex2, oindex2, token, newowner1, amount1, newowner2, amount2]    
    txList = RLPList(_exitingTxBytes, [uint256, uint256, uint256, uint256, uint256, uint256, address, address, uint256, address, uint256])
    if _oIndex == 0:
        return txList[7], txList[6], txList[8], txList[0] * txList[3] # exitor, token, amount, inputCount
    if _oIndex == 1:
        return txList[9], txList[6], txList[10], txList[0] * txList[3] # exitor, token, amount, inputCount
    

@private
@constant
def getUtxoPos(_challengingTxBytes: bytes[1024], _oIndex: uint256) -> uint256:
    assert(_oIndex == 0 or _oIndex == 1)
    # TxField: [blkbum1, txindex1, oindex1, blknum2, txindex2, oindex2, cur12, newowner1, amount1, newowner2, amount2]
    txList = RLPList(_challengingTxBytes, [uint256, uint256, uint256, uint256, uint256, uint256, address, address, uint256, address, uint256])
    if _oIndex == 0:
        return txList[0] + txList[1] + txList[2]
    if _oIndex == 1:
        return txList[3] + txList[4] + txList[5]


@private
@constant
def ecrecoverSig(_txHash: bytes32, _sig: bytes[65]) -> address:
    if len(_sig) != 65:
        return ZERO_ADDRESS
    # ref. https://gist.github.com/axic/5b33912c6f61ae6fd96d6c4a47afde6d
    # The signature format is a compact form of:
    # {bytes32 r}{bytes32 s}{uint8 v}
    r: uint256 = extract32(_sig, 0, type=uint256)
    s: uint256 = extract32(_sig, 32, type=uint256)
    v: int128 = convert(slice(_sig, start=64, len=1), int128)
    # Version of signature should be 27 or 28, but 0 and 1 are also possible versions.
    # geth uses [0, 1] and some clients have followed. This might change, see:
    # https://github.com/ethereum/go-ethereum/issues/2053
    if v < 27:
        v += 27
    if v in [27, 28]:
        return ecrecover(_txHash, convert(v, uint256), r, s)
    return ZERO_ADDRESS


@private
@constant
def checkSigs(_txHash: bytes32, _rootHash: bytes32, _blknum2: uint256, _sigs: bytes[260]) -> bool:
    assert len(_sigs) % 65 == 0
    sig1: bytes[65] = slice(_sigs, start=0, len=65)
    sig2: bytes[65] = slice(_sigs, start=65, len=65)
    confSig1: bytes[65] = slice(_sigs, start=130, len=65)
    confirmationHash: bytes32 = sha3(concat(_txHash, _rootHash))

    check1: bool = True
    check2: bool = True

    check1 = self.ecrecoverSig(_txHash, sig1) == self.ecrecoverSig(confirmationHash, confSig1)
    if _blknum2 > 0:
        confSig2: bytes[65] = slice(_sigs, start=195, len=65)
        check2 = self.ecrecoverSig(_txHash, sig2) == self.ecrecoverSig(confirmationHash, confSig2)

    return check1 and check2


@private
@constant
def checkMembership(_leaf: bytes32, _index: uint256, _rootHash: bytes32, _proof: bytes[512]) -> bool:
    assert len(_proof) == 512
    proofElement: bytes32
    computedHash: bytes32 = _leaf
    index: uint256 = _index

    # 16 = len(_proof) / 32
    for i in range(16):
        proofElement = extract32(_proof, i * 32, type=bytes32)
        if index % 2 == 0:
            computedHash = sha3(concat(computedHash, proofElement))
        else:
            computedHash = sha3(concat(proofElement, computedHash))
        index /= 2
    
    return computedHash == _rootHash    


#
# Public view functions
#

# @dev Queries the child chain.
# @param _blockNumber Number of the block to return.
# @return Child chain block at the specified block number.
@public
@constant
def getChildChain(_blockNumber: uint256) -> (bytes32, timestamp):
    return self.childChain[_blockNumber].root, self.childChain[_blockNumber].blockTimestamp

# @dev Determines the next deposit block number.
# @return Block number to be given to the next deposit block.
@public
@constant
def getDepositBlock() -> uint256:
    # 1000 represents child block interval
    return self.currentChildBlock - 1000 + self.currentDepositBlock

# @dev Returns information about an exit.
# @param _utxoPos Position of the UTXO in the chain.
# @return A tuple representing the active exit for the given UTXO.
@public
@constant
def getExit(_utxoPos: uint256) -> (address, address, uint256):
    return self.exits[_utxoPos].owner, self.exits[_utxoPos].token, self.exits[_utxoPos].amount

# @dev Returns currentFeeExit
@public
@constant
def getCurrentFeeExit() -> uint256:
    return self.currentFeeExit

# @dev Returns currentChildBlock
@public
@constant
def getCurrentChildBlock() -> uint256:
    return self.currentChildBlock

# @dev Determines the next exit to be processed.
@public
@constant
def getNextExit(_token: address) -> (uint256, uint256):
    priority: uint256 = PriorityQueue(self.exitsQueues[_token]).getMin()
    # Cut the first 128 digits which represents exitable_at.
    utxoPos: uint256 = shift(shift(priority, 128), -128)
    exitable_at: uint256 = shift(priority, -128)
    return utxoPos, exitable_at


# @dev Constructor
@public
def __init__(_priorityQueueTemplate: address):
    assert _priorityQueueTemplate != ZERO_ADDRESS
    self.operator = msg.sender
    self.currentChildBlock = 1000 # child block interval
    self.currentDepositBlock = 1
    self.currentFeeExit = 1    

    # Be careful, create_with_code_of currently doesn't support executing constructor.
    priorityQueue: address = create_with_code_of(_priorityQueueTemplate)    
    # Force executing as a constructor
    assert PriorityQueue(priorityQueue).setup()
    # ZERO_ADDRESS means ETH's address(currently support only ETH)
    self.exitsQueues[ZERO_ADDRESS] = priorityQueue


#
# Private functions
#

# @dev Adds an exit to the exit queue.
# @param _utxoPos Position of the UTXO in the child chain.
# @param _exitor Owner of the UTXO.
# @param _token Token to be exited.
# @param _amount Amount to be exited.
# @param _created_at Time when the UTXO was created.
@private
def addExitToQueue(_utxoPos: uint256, _exitor: address, _token: address, _amount: uint256, _created_at: timestamp):
    assert self.exitsQueues[_token] != ZERO_ADDRESS
    # exitable_at is the bigger one - _created_at + 2 weeks and block.timestamp + 1 week
    exitable_at: uint256 = as_unitless_number(max(_created_at + 2 * 7 * 24 * 60 * 60, block.timestamp + 1 * 7 * 24 * 60 * 60))
    # "priority" represents priority of　exitable_at over utxo position.
    priority: uint256 = bitwise_or(shift(exitable_at, 128), _utxoPos)
    assert _amount > 0
    assert self.exits[_utxoPos].amount == 0
    assert PriorityQueue(self.exitsQueues[ZERO_ADDRESS]).insert(priority) # ZERO_ADDRESS means ETH's address
    self.exits[_utxoPos] = Exit({
        owner: _exitor,
        token: _token,
        amount: _amount
    })
    log.ExitStarted(_exitor, _utxoPos, _token, _amount)


#
# Public Functions
#

# @dev Allows Plasma chain operator to submit block root.
# @params _root The root of a child chain block.
@public
def submitBlock(_root: bytes32):
    # Only operator can execute.
    assert msg.sender == self.operator
    self.childChain[self.currentChildBlock] = ChildChainBlock({
        root: _root,
        blockTimestamp: block.timestamp
    })

    # Update block numbers.
    self.currentChildBlock += 1000 # child block interval
    self.currentDepositBlock = 1

    log.BlockSubmitted(_root, block.timestamp) 

# @dev Allows anyone to deposit funds into the Plasma chain.
@public
@payable
def deposit():
    assert self.currentDepositBlock < 1000 # child block interval
    
    root: bytes32 = sha3(
                        concat(
                            convert(msg.sender, bytes32),
                            convert(ZERO_ADDRESS, bytes32), # ZERO_ADDRESS means ETH's address
                            convert(msg.value, bytes32)
                        )
                    )                
    depositBlock: uint256 = self.getDepositBlock()

    self.childChain[depositBlock] = ChildChainBlock({
        root: root,
        blockTimestamp: block.timestamp
    })
    self.currentDepositBlock += 1

    log.Deposit(msg.sender, depositBlock, ZERO_ADDRESS, msg.value)

# @dev Starts an exit from a deposit
# @param _depositPos UTXO position of the deposit
# @param _token Token type to deposit
# @param _amount Deposit amount
@public
def startDepositExit(_depositPos: uint256, _token: address, _amount: uint256):
    blknum: uint256 = _depositPos / 1000000000
    # Check that the given UTXO is a deposit
    assert blknum % 1000 != 0

    root: bytes32 = self.childChain[blknum].root
    depositHash: bytes32 = sha3(
                                concat(
                                    convert(msg.sender, bytes32),
                                    convert(_token, bytes32),
                                    convert(_amount, bytes32)
                                )
                            )
    # Check that the block root of the UTXO position is same as depositHash.
    assert root == depositHash

    self.addExitToQueue(_depositPos, msg.sender, _token, _amount, self.childChain[blknum].blockTimestamp)

# @dev Allows the operator withdraw any allotted fees. Starts an exit to avoid theft.
# @param _token Token to withdraw.
# @param _amount Amount in fees to withdraw.
@public
def startFeeExit(_token: address, _amount: uint256):
    assert msg.sender == self.operator
    self.addExitToQueue(self.currentFeeExit, msg.sender, _token, _amount, block.timestamp + 1)
    self.currentFeeExit += 1
    

# @dev Starts to exit a specified utxo.
# @param _utxoPos The position of the exiting utxo in the format of blknum * 1000000000 + index * 10000 + oindex.
# @param _txBytes The transaction being exited in RLP bytes format excluding signature fields.
# @param _proof Proof of the exiting transactions inclusion for the block specified by utxoPos.
# @param _sigs Both transaction signatures and confirmations signatures used to verify that the exiting transaction has been confirmed.
@public
def startExit(_utxoPos: uint256, _txBytes: bytes[1024], _proof: bytes[512], _sigs: bytes[260]):
    blknum: uint256 = _utxoPos / 1000000000
    txindex: uint256 = (_utxoPos % 1000000000) / 10000
    oindex: uint256 = _utxoPos - blknum * 1000000000 - txindex * 10000

    exitor: address
    token: address
    amount: uint256
    inputCount: uint256
    (exitor, token, amount, inputCount) = self.createExitingTx(_txBytes, oindex)
    assert msg.sender == exitor

    root: bytes32 = self.childChain[blknum].root
    txHash: bytes32 = sha3(_txBytes)
    merkleHash: bytes32 = sha3(concat(txHash, slice(_sigs, start=0, len=130)))

    assert self.checkSigs(txHash, root, inputCount, _sigs)
    assert self.checkMembership(merkleHash, txindex, root, _proof)

    self.addExitToQueue(_utxoPos, exitor, token, amount, self.childChain[blknum].blockTimestamp)


# @dev Allows anyone to challenge an exiting transaction by submitting proof of a double spend on the child chain.
# @param _cUtxoPos The position of the challenging utxo.
# @param _eUtxoIndex The output position of the exiting utxo.
# @param _txBytes The challenging transaction in bytes RLP form excluding signature fields.
# @param _proof Proof of inclusion for the transaction used to challenge.
# @param _sigs Signatures for the transaction used to challenge(It doesn't include confirmations signatures).
# @param _confirmationSig The confirmation signature for the transaction used to challenge.
@public
def challengeExit(_cUtxoPos: uint256, _eUtxoIndex: uint256, _txBytes: bytes[1024], _proof: bytes[512], _sigs: bytes[130], _confirmationSig: bytes[65]):
    # The position of the exiting utxo
    eUtxoPos: uint256 = self.getUtxoPos(_txBytes, _eUtxoIndex)
    # The output position of the challenging utxo
    txindex: uint256 = (_cUtxoPos % 1000000000) / 10000
    # The block root of the challenging utxo
    root: bytes32 = self.childChain[_cUtxoPos / 1000000000].root
    # The hash of the challenging transaction
    txHash: bytes32 = sha3(_txBytes)

    confirmationHash: bytes32 = sha3(concat(txHash, root))
    merkleHash: bytes32 = sha3(concat(txHash, _sigs))
    # The owner of the exiting utxo
    owner: address = self.exits[eUtxoPos].owner
    
    # Check the owner of the exiting utxo is same as that of the confirmation signature to check a double spend.
    # if the utxo is a double spend, the confirmation signature was made by the owner of the exiting utxo.
    assert owner == self.ecrecoverSig(confirmationHash, _confirmationSig)
    # Check the merkle proof of the transaction used to challenge
    assert self.checkMembership(merkleHash, txindex, root, _proof)

    # # Delete the owner but keep the amount to prevent another exit
    self.exits[eUtxoPos].owner = ZERO_ADDRESS


# @dev Processes any exits that have completed the challenge period.
# @param _token Token type to process.
@public
def finalizeExits(_token: address):   
    utxoPos: uint256
    exitable_at: uint256
    (utxoPos, exitable_at) = self.getNextExit(_token)

    currentExit: Exit = self.exits[utxoPos]
    for i in range(1073741824): # 1073741824 is 2^30, max size of priority queue is 2^30 - 1
        if not exitable_at < as_unitless_number(block.timestamp):
            break
        currentExit = self.exits[utxoPos]
        
        # Only ETH is allowed
        assert _token == ZERO_ADDRESS
        # Send the token amount of the exiting utxo to the owner of the utxo
        send(currentExit.owner, as_wei_value(currentExit.amount, "wei"))
        
        PriorityQueue(self.exitsQueues[_token]).delMin()
        # Delete owner of the utxo
        self.exits[utxoPos].owner = ZERO_ADDRESS

        if PriorityQueue(self.exitsQueues[_token]).getCurrentSize() > 0:
            (utxoPos, exitable_at) = self.getNextExit(_token)
        else:
            return
