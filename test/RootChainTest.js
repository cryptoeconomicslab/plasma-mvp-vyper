const utils = require("ethereumjs-util");
const { latestTime } = require('./helpers/latestTime');
const { increaseTime, duration } = require('./helpers/increaseTime');
const { deployRLPdecoder } = require('./helpers/deployRLPdecoder');
const { EVMRevert } = require('./helpers/EVMRevert');
const { expectThrow } = require('./helpers/expectThrow');
const FixedMerkleTree = require('./helpers/fixedMerkleTree');
const { keys } = require('./helpers/keys');
const { getTransactionGasCost } = require('./helpers/getGasCost');

const RootChain = artifacts.require("root_chain");
const PriorityQueue = artifacts.require("priority_queue");

const BigNumber = web3.BigNumber;

require('chai')
    .use(require('chai-as-promised'))
    .use(require('chai-bignumber')(BigNumber))
    .should();


contract("RootChain", ([owner, nonOwner]) => {
    let rootChain;
    const depositAmount = new BigNumber(web3.toWei(0.01, 'ether'));
    const depositAmountNum = Number(depositAmount);
    const utxoOrder = new BigNumber(1000000000);
    const num1 = new BigNumber(1);
    const num2 = new BigNumber(2);

    const owenerKey = keys[0];
    const nonOwnerKey = keys[1];
    const ZERO_ADDRESS = utils.bufferToHex(utils.zeros(20));

    deployRLPdecoder();
    

    beforeEach(async () => {
        priorityQueue = await PriorityQueue.new();
        rootChain = await RootChain.new(priorityQueue.address, { from: owner });
    });

    describe("deposit", () => {
        it("should accespt deposit", async () => {
            const blknum = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: owner });
            const depositBlockNum = await rootChain.getDepositBlock();
            depositBlockNum.should.be.bignumber.equal(blknum.plus(num1));
        })
    });

    describe("startDepositExit", () => {
        beforeEach(async () => {
            await rootChain.deposit({ value: depositAmount, from: owner });
            this.blknum = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: owner });
            this.expectedUtxoPos = this.blknum.mul(utxoOrder);
        })

        it("should be equal utxoPos and exitableAt ", async () => {
            const expectedExitableAt = (await latestTime()) + duration.weeks(2);

            await rootChain.startDepositExit(this.expectedUtxoPos, ZERO_ADDRESS, depositAmountNum);
            const [utxoPos, exitableAt] = await rootChain.getNextExit(ZERO_ADDRESS);

            exitableAt.should.be.bignumber.equal(expectedExitableAt);
            utxoPos.should.be.bignumber.equal(this.expectedUtxoPos);

            const [expectedOwner, token, amount] = await rootChain.getExit(utxoPos);
            expectedOwner.should.equal = owner;
            token.should.equal = ZERO_ADDRESS;
            amount.should.equal = depositAmount;
        });

        it("should fail if same deposit is exited twice", async () => {
            await rootChain.startDepositExit(this.expectedUtxoPos, ZERO_ADDRESS, depositAmountNum);
            await expectThrow(
                rootChain.startDepositExit(this.expectedUtxoPos, ZERO_ADDRESS, depositAmountNum),
                EVMRevert
            );
        });

        it("should fail if transaction sender is not the depositor", async () => {
            await expectThrow(
                rootChain.startDepositExit(this.expectedUtxoPos, ZERO_ADDRESS, depositAmountNum, { from: nonOwner }),
                EVMRevert
            );
        });

        it("should fail if utxoPos is worng", async () => {
            await expectThrow(
                rootChain.startDepositExit(this.expectedUtxoPos * 2, ZERO_ADDRESS, depositAmountNum),
                EVMRevert
            );
        });

        it("should fail if value given is not equal to deposited value (mul 2)", async () => {
            await expectThrow(
                rootChain.startDepositExit(this.expectedUtxoPos, ZERO_ADDRESS, depositAmountNum * 2),
                EVMRevert
            );
        });
    });

    describe("startFeeExit", () => {
        it("fee exit should get exitable after deposit exit", async () => {
            let utxoPos;

            const blknum = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: owner });

            (await rootChain.getCurrentFeeExit()).should.be.bignumber.equal(num1);

            const expectedUtxoAt = await rootChain.getCurrentFeeExit();
            const expectedExitableAt = (await latestTime()) + duration.weeks(2) + 1;

            await rootChain.startFeeExit(ZERO_ADDRESS, 1);
            (await rootChain.getCurrentFeeExit()).should.be.bignumber.equal(num2);

            [utxoPos, feeExitableAt] = await rootChain.getNextExit(ZERO_ADDRESS);

            utxoPos.should.be.bignumber.equal(expectedUtxoAt);
            feeExitableAt.should.be.bignumber.equal(expectedExitableAt);

            const expectedUtxoPos = blknum.mul(utxoOrder).plus(num1);
            await rootChain.startDepositExit(expectedUtxoPos, ZERO_ADDRESS, depositAmount);

            [utxoPos, depositExitableAt] = await rootChain.getNextExit(ZERO_ADDRESS);
            feeExitableAt.should.be.bignumber.above(depositExitableAt);
        });

        it("should fail if transaction sender isn't the authority", async () => {
            await rootChain.deposit({ value: depositAmount, from: owner });
            await expectThrow(rootChain.startFeeExit(ZERO_ADDRESS, 1, { from: nonOwner }), EVMRevert);
        });
    });

    describe("startExit", () => {
        let expectedOwner, tokenAddr, expectedAmount;

        it("cannot exit twice off of the same utxo", async () => {
            const tx1 = [
                utils.toBuffer(0), // blkbum1
                utils.toBuffer(0), // txindex1
                utils.toBuffer(0), // oindex1

                utils.toBuffer(0), // blknum2
                utils.toBuffer(0), // txindex2
                utils.toBuffer(0), // oindex2

                utils.zeros(20), // token address

                utils.toBuffer(owner), // newowner1
                utils.toBuffer(depositAmountNum), // amount1

                utils.zeros(20), // newowner2
                utils.toBuffer(0) // amount2   
            ];

            // RLP encoded tx1            
            const encodedTx1 = "0xf84e00000000000094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000000";

            const depositBlknum = await rootChain.getDepositBlock();
            depositBlknum.should.be.bignumber.equal(num1);

            await rootChain.deposit({ value: depositAmount, from: owner });

            const vrs = utils.ecsign(utils.sha3(encodedTx1), owenerKey);
            const sig1 = utils.toBuffer(utils.toRpcSig(vrs.v, vrs.r, vrs.s));

            const merkleHash = utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx1)), sig1, utils.zeros(65)]));

            const tree = new FixedMerkleTree(16, [merkleHash]);
            const proof = utils.bufferToHex(Buffer.concat(tree.getPlasmaProof(merkleHash)));

            const [root, _] = await rootChain.getChildChain(Number(depositBlknum));
            const sigs = utils.bufferToHex(
                Buffer.concat([
                    sig1,
                    utils.zeros(65)
                ])
            );

            const priority1 = Number(depositBlknum) * 1000000000 + 10000 * 0 + 1;
            const utxoId = Number(depositBlknum) * 1000000000 + 10000 * 0 + 1;

            await rootChain.startDepositExit(utxoId, ZERO_ADDRESS, Number(depositAmount));
            await increaseTime(duration.weeks(1.5));

            const utxoPos1 = Number(depositBlknum) * 1000000000 + 10000 * 0 + 1;

            await expectThrow(rootChain.startExit(utxoPos1, encodedTx1, proof, sigs), EVMRevert);

            [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(priority1);
            expectedOwner.should.equal(owner);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);
        });

        it("can exit single input", async () => {
            const depositBlknum = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: owner });

            const tx2 = [
                utils.toBuffer(Number(depositBlknum)), // blkbum1
                utils.toBuffer(0), // txindex1
                utils.toBuffer(0), // oindex1

                utils.toBuffer(0), // blknum2
                utils.toBuffer(0), // txindex2
                utils.toBuffer(0), // oindex2

                utils.zeros(20), // token address

                utils.toBuffer(owner), // newowner1                
                utils.toBuffer(depositAmountNum), // amount1

                utils.zeros(20), // newowner2
                utils.toBuffer(0), // amount2           
            ];

            // RLP encoded tx2 because of RLP Decoder in vyper
            const encodedTx2 = "0xf84e01000000000094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000000";
            // const encodedTx2 = "0xf84e02808080808094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000080";            

            const vrs = utils.ecsign(utils.sha3(encodedTx2), owenerKey);
            const sig1 = utils.toBuffer(utils.toRpcSig(vrs.v, vrs.r, vrs.s));

            const merkleHash = utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx2)), sig1, utils.zeros(65)]));

            const tree = new FixedMerkleTree(16, [merkleHash]);
            const proof = utils.bufferToHex(Buffer.concat(tree.getPlasmaProof(merkleHash)));

            const childBlknum = await rootChain.getCurrentChildBlock();
            childBlknum.should.be.bignumber.equal(new BigNumber(1000));

            await rootChain.submitBlock(utils.bufferToHex(tree.getRoot()));

            const priority2 = Number(childBlknum) * 1000000000 + 10000 * 0 + 0;
            const [root, _] = await rootChain.getChildChain(Number(childBlknum));

            const confVrs = utils.ecsign(
                utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx2)), utils.toBuffer(root)])),
                owenerKey
            );
            const confirmSig = utils.toBuffer(utils.toRpcSig(confVrs.v, confVrs.r, confVrs.s));

            const sigs = utils.bufferToHex(
                Buffer.concat([
                    sig1,
                    utils.zeros(65),
                    confirmSig
                ])
            );

            const utxoPos2 = Number(childBlknum) * 1000000000 + 10000 * 0 + 0;

            await rootChain.startExit(utxoPos2, encodedTx2, proof, sigs);

            [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(priority2);
            expectedOwner.should.equal(owner);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);
        });

        it("can exit double input (and submit block twice)", async () => {
            const depositBlknum = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: owner });

            const depositBlknum2 = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: nonOwner });

            const tx3 = [
                utils.toBuffer(Number(depositBlknum)), // blkbum1
                utils.toBuffer(0), // txindex1
                utils.toBuffer(0), // oindex1

                utils.toBuffer(Number(depositBlknum2)), // blknum2
                utils.toBuffer(0), // txindex2
                utils.toBuffer(0), // oindex2

                utils.zeros(20), // token address

                utils.toBuffer(nonOwner), // newowner1                
                utils.toBuffer(depositAmountNum), // amount1

                utils.zeros(20), // newowner2
                utils.toBuffer(0), // amount2           
            ];

            // RLP encoded tx3 because of RLP Decoder in vyper
            const encodedTx3 = "0xf84e01000002000094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000000";

            const vrs1 = utils.ecsign(utils.sha3(encodedTx3), owenerKey);
            const sig1 = utils.toBuffer(utils.toRpcSig(vrs1.v, vrs1.r, vrs1.s));

            const vrs2 = utils.ecsign(utils.sha3(encodedTx3), nonOwnerKey);
            const sig2 = utils.toBuffer(utils.toRpcSig(vrs2.v, vrs2.r, vrs2.s));

            const merkleHash = utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx3)), sig1, sig2]));

            const tree = new FixedMerkleTree(16, [merkleHash]);
            const proof = utils.bufferToHex(Buffer.concat(tree.getPlasmaProof(merkleHash)));

            const childBlknum = await rootChain.getCurrentChildBlock();
            childBlknum.should.be.bignumber.equal(new BigNumber(1000));

            await rootChain.submitBlock(utils.bufferToHex(tree.getRoot()));

            const priority2 = Number(childBlknum) * 1000000000 + 10000 * 0 + 0;
            const [root, _] = await rootChain.getChildChain(Number(childBlknum));

            const confVrs1 = utils.ecsign(
                utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx3)), utils.toBuffer(root)])),
                owenerKey
            );
            const confirmSig1 = utils.toBuffer(utils.toRpcSig(confVrs1.v, confVrs1.r, confVrs1.s));

            const confVrs2 = utils.ecsign(
                utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx3)), utils.toBuffer(root)])),
                nonOwnerKey
            );
            const confirmSig2 = utils.toBuffer(utils.toRpcSig(confVrs2.v, confVrs2.r, confVrs2.s));

            const sigs = utils.bufferToHex(
                Buffer.concat([
                    sig1,
                    sig2,
                    confirmSig1,
                    confirmSig2
                ])
            );

            const utxoPos2 = Number(childBlknum) * 1000000000 + 10000 * 0 + 0;

            await rootChain.startExit(utxoPos2, encodedTx3, proof, sigs);

            [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(priority2);
            expectedOwner.should.equal(owner);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);
        });
    });

    describe("challengeExit", () => {
        beforeEach(async () => {
            const tx1 = [
                utils.toBuffer(0), // blkbum1
                utils.toBuffer(0), // txindex1
                utils.toBuffer(0), // oindex1

                utils.toBuffer(0), // blknum2
                utils.toBuffer(0), // txindex2
                utils.toBuffer(0), // oindex2

                utils.zeros(20), // token address

                utils.toBuffer(nonOwner), // newowner1
                utils.toBuffer(depositAmountNum), // amount1

                utils.zeros(20), // newowner2
                utils.toBuffer(0) // amount2   
            ];

            const encodedTx1 = "0xf84e00000000000094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000000";

            let depositBlknum = await rootChain.getDepositBlock();

            this.utxoPos1 = Number(depositBlknum) * 1000000000 + 1;
            await rootChain.deposit({ value: depositAmount, from: owner });

            depositBlknum = await rootChain.getDepositBlock();
            const utxoPos2 = Number(depositBlknum) * 1000000000;
            await rootChain.deposit({ value: depositAmount, from: owner });

            let merkleHash = utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx1)), utils.zeros(65), utils.zeros(65)]));

            let tree = new FixedMerkleTree(16, [merkleHash]);

            let [root, _] = await rootChain.getChildChain(Number(this.utxoPos1));

            let confVrs = utils.ecsign(
                utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(encodedTx1)), utils.toBuffer(root)])),
                owenerKey
            );

            await rootChain.startDepositExit(this.utxoPos1, ZERO_ADDRESS, Number(depositAmount));

            const tx3 = [
                utils.toBuffer(utxoPos2), // blkbum1                
                utils.toBuffer(0), // txindex1
                utils.toBuffer(0), // oindex1

                utils.toBuffer(0), // blknum2
                utils.toBuffer(0), // txindex2
                utils.toBuffer(0), // oindex2

                utils.zeros(20), // token address

                utils.toBuffer(owner), // newowner1
                utils.toBuffer(depositAmountNum), // amount1

                utils.zeros(20), // newowner2
                utils.toBuffer(0) // amount2           
            ];

            this.encodedTx3 = "0xf8528477359400000000000094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000000";

            let vrs1 = utils.ecsign(utils.sha3(this.encodedTx3), owenerKey);
            let sig1 = utils.toBuffer(utils.toRpcSig(vrs1.v, vrs1.r, vrs1.s));

            merkleHash = utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(this.encodedTx3)), sig1, utils.zeros(65)]));

            tree = new FixedMerkleTree(16, [merkleHash]);

            let childBlknum = await rootChain.getCurrentChildBlock();
            await rootChain.submitBlock(utils.bufferToHex(tree.getRoot()));

            [root, _] = await rootChain.getChildChain(Number(childBlknum));

            confVrs = utils.ecsign(
                utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(this.encodedTx3)), utils.toBuffer(root)])),
                owenerKey
            );

            this.utxoPos3 = Number(childBlknum) * 1000000000 + 10000 * 0 + 0;


            const tx4 = [
                utils.toBuffer(this.utxoPos1), // blkbum1                
                utils.toBuffer(0), // txindex1
                utils.toBuffer(0), // oindex1

                utils.toBuffer(0), // blknum2
                utils.toBuffer(0), // txindex2
                utils.toBuffer(0), // oindex2

                utils.zeros(20), // token address

                utils.toBuffer(owner), // newowner1
                utils.toBuffer(depositAmountNum), // amount1

                utils.zeros(20), // newowner2
                utils.toBuffer(0) // amount2           
            ];

            this.encodedTx4 = "0xf852843b9aca01000000000094000000000000000000000000000000000000000094627306090abab3a6e1400e9345bc60c78a8bef57872386f26fc1000094000000000000000000000000000000000000000000";

            vrs1 = utils.ecsign(utils.sha3(this.encodedTx4), owenerKey);
            sig1 = utils.toBuffer(utils.toRpcSig(vrs1.v, vrs1.r, vrs1.s));

            merkleHash = utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(this.encodedTx4)), sig1, utils.zeros(65)]));
            tree = new FixedMerkleTree(16, [merkleHash]);
            this.proof = utils.bufferToHex(Buffer.concat(tree.getPlasmaProof(merkleHash)));

            childBlknum = await rootChain.getCurrentChildBlock();
            await rootChain.submitBlock(utils.bufferToHex(tree.getRoot()));

            [root, _] = await rootChain.getChildChain(Number(childBlknum));

            confVrs = utils.ecsign(
                utils.sha3(Buffer.concat([utils.toBuffer(utils.sha3(this.encodedTx4)), utils.toBuffer(root)])),
                owenerKey
            );
            this.confirmSig = utils.bufferToHex(utils.toBuffer(utils.toRpcSig(confVrs.v, confVrs.r, confVrs.s)));

            this.sigs = utils.bufferToHex(
                Buffer.concat([
                    sig1,
                    utils.zeros(65)
                ])
            );

            this.utxoPos4 = Number(childBlknum) * 1000000000 + 10000 * 0 + 0;
            this.oindex1 = 0;
        })

        it("can challenge exit", async () => {
            [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(this.utxoPos1);
            expectedOwner.should.equal(owner);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);

            await rootChain.challengeExit(this.utxoPos4, this.oindex1, this.encodedTx4, this.proof, this.sigs, this.confirmSig);

            [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(this.utxoPos1);
            expectedOwner.should.equal(ZERO_ADDRESS);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);
        });

        it("should fails if transaction after exit doesn't reference the utxo being exited", async () => {
            await expectThrow(rootChain.challengeExit(this.utxoPos3, this.oindex1, this.encodedTx3, this.proof, this.sigs, this.confirmSig), EVMRevert);
        });

        it("should fails if transaction proof is incorrect", async () => {
            const reverseProof = this.proof
                .slice(2)
                .split('')
                .reverse()
                .join('');

            await expectThrow(rootChain.challengeExit(this.utxoPos4, this.oindex1, this.encodedTx4, reverseProof, this.sigs, this.confirmSig), EVMRevert);
        });

        it("should fails if transaction confirmation is incorrect", async () => {
            const reverseConfirmSig = this.confirmSig
                .slice(2)
                .split('')
                .reverse()
                .join('');

            await expectThrow(rootChain.challengeExit(this.utxoPos4, this.oindex1, this.encodedTx4, this.proof, this.sigs, reverseConfirmSig), EVMRevert);
        });
    });


    describe("finalizeExits", () => {
        it("can start exits and finalize exits", async () => {
            const depositBlknum1 = await rootChain.getDepositBlock();
            await rootChain.deposit({ value: depositAmount, from: owner });
            const utxoPos1 = Number(depositBlknum1) * 1000000000 + 10000 * 0;

            await rootChain.startDepositExit(utxoPos1, ZERO_ADDRESS, Number(depositAmount), { from: owner });
            await increaseTime(duration.weeks(4));

            let [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(utxoPos1);
            expectedOwner.should.equal(owner);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);

            const preBalance = web3.eth.getBalance(owner);
            const res = await rootChain.finalizeExits(ZERO_ADDRESS);
            const gasCost = getTransactionGasCost(res["tx"]);
            const postBalance = web3.eth.getBalance(owner);

            postBalance.plus(gasCost).should.be.bignumber.equal(preBalance.plus(depositAmount));

            [expectedOwner, tokenAddr, expectedAmount] = await rootChain.getExit(utxoPos1);
            expectedOwner.should.equal(ZERO_ADDRESS);
            tokenAddr.should.equal(ZERO_ADDRESS);
            expectedAmount.should.be.bignumber.equal(depositAmount);
        });
    });
});
