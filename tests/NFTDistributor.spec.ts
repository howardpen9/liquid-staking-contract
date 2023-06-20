import { Blockchain, SandboxContract, TreasuryContract, BlockchainSnapshot, internal } from '@ton-community/sandbox';
import { Address, Cell, toNano, beginCell } from 'ton-core';
import { PayoutCollection, Errors, Op, Distribution } from '../wrappers/PayoutNFTCollection';
import { PayoutItem } from '../wrappers/PayoutNFTItem';
import { JettonMinter as DAOJettonMinter } from '../contracts/jetton_dao/wrappers/JettonMinter';
import '@ton-community/test-utils';
import { compile } from '@ton-community/blueprint';
import { randomAddress } from '@ton-community/test-utils';
import { getRandomInt, getRandomTon } from '../utils'


const SLUGGISH_TESTS = false;

describe('Distributor NFT Collection', () => {
    let blockchain: Blockchain;
    let snapshots: Map<string, BlockchainSnapshot>
    let loadSnapshot: (snap: string) => Promise<void>;
    let shares: Map<Address, bigint>;
    let sharesExtended: Map<Address, bigint>;
    let collection: SandboxContract<PayoutCollection>
    let deployer: SandboxContract<TreasuryContract>;
    let notDeployer: SandboxContract<TreasuryContract>;
    let poolJetton: SandboxContract<DAOJettonMinter>;
    let collectionCode: Cell;
    let itemCode: Cell;
    let dao_voting_code: Cell;
    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;
    let totalBill: bigint;
    let initDistribution: Distribution;
    let jwalletAddr: Address

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury("deployer");
        notDeployer = await blockchain.treasury("notDeployer");
        collectionCode = await compile('PayoutNFTCollection');
        itemCode = await compile('PayoutNFTItem');
        let config = {
            admin: deployer.address,
            content: Cell.EMPTY
        }
        collection = blockchain.openContract(PayoutCollection.createFromConfig(config, collectionCode));
        loadSnapshot = async (name: string) => {
          const shot = snapshots.get(name);
          if(!shot)
            throw(Error(`Can't find snapshot ${name}\nCheck tests execution order`));
          await blockchain.loadFrom(shot);
        }

        dao_minter_code = await compile('DAOJettonMinter');
        dao_wallet_code = await compile('DAOJettonWallet');
        dao_voting_code = await compile('DAOVoting');
        poolJetton  = blockchain.openContract(DAOJettonMinter.createFromConfig({
                                                  admin: deployer.address,
                                                  content: Cell.EMPTY,
                                                  voting_code: dao_voting_code},
                                                  dao_minter_code));
        // to use it in all "describe" blocks
        await poolJetton.sendDeploy(deployer.getSender(), toNano("10"));
        jwalletAddr = await poolJetton.getWalletAddress(collection.address);

        snapshots = new Map<string, BlockchainSnapshot>();
        shares = new Map<Address, bigint>();
        totalBill = 0n;
        for (let addr of [deployer.address, notDeployer.address, randomAddress()]) {
            const share = getRandomTon(1, 100000);
            totalBill += share;
            shares.set(addr, share);
        }
        sharesExtended = new Map(shares)
    });

    async function deploy() {
        await loadSnapshot("uninitialized");
        const deployResult = await collection.sendDeploy(deployer.getSender(), initDistribution, toNano("1"));
        expect(deployResult.transactions).toHaveTransaction({
            to: collection.address,
            success: true,
            endStatus: 'active'
        });
        snapshots.set("initialized", blockchain.snapshot());
    }
    async function mint() {
        await loadSnapshot("initialized");
        const dataBefore = await collection.getCollectionData();
        let index = dataBefore.nextItemIndex;
        for (let [addr, share] of shares) {
            const mintResult = await collection.sendMint(deployer.getSender(), addr, share);
            const nftAddress = await collection.getNFTAddress(index);
            expect(mintResult.transactions).toHaveTransaction({
                to: collection.address,
                success: true,
                outMessagesCount: 1
            });
            expect(mintResult.transactions).toHaveTransaction({
                from: collection.address,
                to: nftAddress,
                success: true,
                deploy: true
            });
            expect(mintResult.transactions).toHaveTransaction({
                from: nftAddress,
                to: addr,
                op: Op.ownership_assigned
            });
            index++;
        }
        const dataAfter = await collection.getCollectionData();
        expect(dataAfter.nextItemIndex).toEqual(index);
        const bill = await collection.getTotalBill();
        expect(bill).toEqual(totalBill);
        snapshots.set("minted", blockchain.snapshot());
    }
    async function needInit() {
        await loadSnapshot("uninitialized");
        const mintResult = await collection.sendMint(deployer.getSender(), randomAddress(), getRandomTon(1, 100));
        expect(mintResult.transactions).toHaveTransaction({
            to: collection.address,
            success: false,
            exitCode: Errors.need_init
        });
    }
    async function mintExtended() {
       await loadSnapshot("minted");
       const nftAmount = getRandomInt(600, 1200);
       const dataBefore = await collection.getCollectionData();
       for (let i = 0; i < nftAmount; i++) {
           const addr = randomAddress();
           const share = getRandomTon(1, 100000);
           sharesExtended.set(addr, share);
           const mintResult = await collection.sendMint(deployer.getSender(), addr, share);
           expect(mintResult.transactions).toHaveTransaction({
               from: deployer.address,
               to: collection.address,
               success: true,
           });
        }
        const collectionData = await collection.getCollectionData();
        expect(collectionData.nextItemIndex).toEqual(dataBefore.nextItemIndex + BigInt(nftAmount));
        snapshots.set("minted_extended", blockchain.snapshot());
    }

    async function distributeTONs(_shares: Map<Address, bigint>) {
        // no snapshots, "inline". taken out to test again with a lot of NFTs
        const assetAmount = getRandomTon(100, 10000);
        const billBefore = await collection.getTotalBill();
        const sendStartResult = await collection.sendStartDistribution(deployer.getSender(), assetAmount);
        expect(sendStartResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: collection.address,
            success: true,
        });
        let i = 0n;
        for (let [addr, share] of _shares) {
            const expectedBillShare = assetAmount * share / billBefore;
            const nftAddr = await collection.getNFTAddress(i);
            expect(sendStartResult.transactions).toHaveTransaction({
                from: nftAddr,
                to: collection.address,
                success: true,
                op: Op.burn_notification
            });
            expect(sendStartResult.transactions).toHaveTransaction({
                from: collection.address,
                to: addr,
                op: Op.distributed_asset,
                value: (x) => x! >= expectedBillShare - toNano("0.1")
            });
            i++;
        }
        const billAfter = await collection.getTotalBill();
        expect(billAfter).toEqual(0n);
        const collectionData = await collection.getDistribution();
        expect(collectionData.active).toEqual(true);
    }
    async function distributeJettons(_shares: Map<Address, bigint>) {
        const assetAmount = getRandomTon(100, 10000);
        const billBefore = await collection.getTotalBill();
        const mintAssetResult = await poolJetton.sendMint(deployer.getSender(), collection.address, assetAmount, toNano("0.1"), toNano("0.5"))
        expect(mintAssetResult.transactions).toHaveTransaction({
            from: jwalletAddr,
            to: collection.address,
            op: Op.transfer_notification,
            success: true
        });
        for (let [addr, share] of shares) {
            const userWalletAddr = await poolJetton.getWalletAddress(addr);
            const expectedJettonsRecieved = assetAmount * share / billBefore;
            expect(mintAssetResult.transactions).toHaveTransaction({
                from: userWalletAddr,
                to: addr,
                op: Op.transfer_notification,
                body: (x) => {x!
                    let cs = x.beginParse().skip(32 + 64)
                    let jetton_amount = cs.loadCoins()
                    let addr_serialization = cs.loadUint(2)
                   return (expectedJettonsRecieved + 5n >= jetton_amount)
                       || (jetton_amount >= expectedJettonsRecieved - 5n)
                       && (addr_serialization == 0b00) // recieved from null address
                }
            });
        }
    }
    describe("Distributing TONs", () => {
        beforeAll(async () => {
            initDistribution = {
                active: false,
                isJetton: false,
                volume: 0n
            }
        });
        it('should not deploy (init) not from admin', async () => {
            const deployResult = await collection.sendDeploy(notDeployer.getSender(), initDistribution, toNano("0.5"));
            expect(deployResult.transactions).toHaveTransaction({
                to: collection.address,
                success: false,
                exitCode: Errors.unauthorized_init
            });
            snapshots.set("uninitialized", blockchain.snapshot());
        });

        it("should deploy collection with ton distribution", deploy);

        it("should mint NFT", mint);

        it("should not mint not from admin", async () => {
            await loadSnapshot("initialized");
            const mintResult = await collection.sendMint(notDeployer.getSender(), randomAddress(), getRandomTon(1, 100));
            expect(mintResult.transactions).toHaveTransaction({
                to: collection.address,
                success: false,
                exitCode: Errors.unauthorized_mint_request
            });
        });
        it("should not mint if uninitialized", needInit);

        it('should deploy item not from admin with failed init', async () => {
            await loadSnapshot("minted");
            const mintBody = PayoutCollection.mintMessage(notDeployer.address, getRandomTon(1, 100));
            const collectionData = await collection.getCollectionData();
            const index = collectionData.nextItemIndex;
            const nftAddress = await collection.getNFTAddress(index);
            const nftItem = blockchain.openContract(PayoutItem.createFromConfig({admin: collection.address, index}, itemCode));
            const mintResult = await blockchain.sendMessage(internal({
                from: notDeployer.address,
                to: nftAddress,
                value: toNano("0.3"),
                bounce: false,
                body: mintBody,
                stateInit: nftItem.init
            }));
            expect(mintResult.transactions).toHaveTransaction({
                from: notDeployer.address,
                to: nftAddress,
                deploy: true,
                success: false,
                endStatus: 'active',
                exitCode: Errors.unauthorized_init
            });
            const bill = await collection.getTotalBill();
            expect(bill).toEqual(totalBill);
            const nftSmc = await blockchain.getContract(nftItem.address);
            if (nftSmc.accountState?.type === 'active') {
                const initedBit = nftSmc.accountState?.state.data?.beginParse().loadBit();
                expect(initedBit).toEqual(false);
            } else throw Error(`Can't get state of ${nftItem.address}`);

            snapshots.set("uninited_item", blockchain.snapshot());
        });
        it('should init previously deployed item', async () => {
            await loadSnapshot("uninited_item");
            const collectionData = await collection.getCollectionData();
            const index = collectionData.nextItemIndex;
            const nftAddress = await collection.getNFTAddress(index);
            const mintResult = await collection.sendMint(deployer.getSender(), randomAddress(), getRandomTon(1, 100));
            expect(mintResult.transactions).toHaveTransaction({
                from: collection.address,
                to: nftAddress,
                success: true,
            });
            const nftItem = blockchain.openContract(PayoutItem.createFromAddress(nftAddress));
            const nftData = await nftItem.getNFTData();
            expect(nftData.inited).toEqual(true);
        });

        // TODO: test with minimal mint amount. Now collection doesn't check it and mint may fail on NFT side.

        it('nft may not be burned by owner or someONE else', async () => {
            await loadSnapshot("minted");
            const deployerNFTAddr = await collection.getNFTAddress(0n);
            const deployerNFT = blockchain.openContract(PayoutItem.createFromAddress(deployerNFTAddr));
            const { owner } = await deployerNFT.getNFTData();
            expect(owner.equals(deployer.address)).toEqual(true);
            const sendResult1 = await deployerNFT.sendBurn(deployer.getSender(), toNano('0.1'));
            const sendResult2 = await deployerNFT.sendBurn(notDeployer.getSender(), toNano('0.1'));
            for (let res of [sendResult1, sendResult2])
              expect(res.transactions).toHaveTransaction({
                  to: deployerNFTAddr,
                  success: false,
                  exitCode: Errors.unauthorized
              });
        });
        it('should not start distribution not from admin', async () => {
            await loadSnapshot("minted");
            const sendStartResult = await collection.sendStartDistribution(notDeployer.getSender(), toNano(1000));
            expect(sendStartResult.transactions).toHaveTransaction({
                from: notDeployer.address,
                to: collection.address,
                success: false,
                exitCode: Errors.unauthorized_start_request
            });
        });
        it("should not start distribution if uninitialized", async () => {
            await loadSnapshot("uninitialized");
            const sendStartResult = await collection.sendStartDistribution(deployer.getSender(), toNano(1000));
            expect(sendStartResult.transactions).toHaveTransaction({
                to: collection.address,
                success: false,
                exitCode: Errors.need_init
            });
        });
        it("should not start distribution of jettons", async () => {
            await loadSnapshot("minted");
            const mintAssetResult = await poolJetton.sendMint(deployer.getSender(), collection.address, toNano(1000), toNano("0.1"), toNano("0.5"))
            expect(mintAssetResult.transactions).toHaveTransaction({ // internal transfer
                from: poolJetton.address,
                to: jwalletAddr,
                success: true
            });
            expect(mintAssetResult.transactions).toHaveTransaction({
                from: jwalletAddr,
                to: collection.address,
                op: Op.transfer_notification,
                success: false,
                exitCode: Errors.cannot_distribute_jettons
            });
        });
        it("should not start distribution if funds are not enough for fees", async () => {
            await loadSnapshot("minted");
            const start_distribution_gas_usage = toNano("0.01")
            let sendStartResult = await collection.sendStartDistribution(deployer.getSender(), start_distribution_gas_usage - 1n);
            expect(sendStartResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: collection.address,
                aborted: true,
            });
            sendStartResult = await collection.sendStartDistribution(deployer.getSender(), start_distribution_gas_usage);
            expect(sendStartResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: collection.address,
                success: true,
            });
        });
        it("should distribute TONs", async () => {
            await loadSnapshot("minted");
            await distributeTONs(shares);
            snapshots.set("distributed", blockchain.snapshot());
        });
        it("should not distribute again", async () => {
            await loadSnapshot("distributed");
            const sendStartResult = await collection.sendStartDistribution(deployer.getSender(), toNano(1000));
            expect(sendStartResult.transactions).toHaveTransaction({
                to: collection.address,
                success: false,
                exitCode: Errors.distribution_already_started
            });
        });
        it("should start distribution and take a snapshot before the chain end", async () => {
            await loadSnapshot("minted");
            const assetAmount = getRandomTon(100, 10000);
            const collectionSmc = await blockchain.getContract(collection.address);
            collectionSmc.receiveMessage(internal({
                from: deployer.address,
                to: collection.address,
                body: PayoutCollection.startDistributionMessage(),
                value: assetAmount
            }));
            const distribution = await collection.getDistribution();
            expect(distribution.active).toEqual(true);
            expect(distribution.volume).toEqual(assetAmount - toNano("0.01"));
            snapshots.set("distribution", blockchain.snapshot());
        });
        const burnNotification = (amount: bigint, from: Address, index: bigint) => {
            return beginCell()
                .storeUint(Op.burn_notification, 32)
                .storeUint(0, 64)
                .storeCoins(amount)
                .storeAddress(from)
                .storeUint(index, 64)
               .endCell();
        }
        it('should accept burn messages only from NFTs', async () => {
            await loadSnapshot("distribution");
            const burnAmount = toNano(1000);
            const from = randomAddress();
            const fakeRes = await blockchain.sendMessage(internal({
                from, to: collection.address,
                body: burnNotification(burnAmount, deployer.address, 0n),
                value: toNano('0.1')
            }));
            expect(fakeRes.transactions).toHaveTransaction({
                from, to: collection.address,
                aborted: true,
                exitCode: Errors.unauthorized_burn_notification,
                outMessagesCount: 1
            });
            const nftAddr = await collection.getNFTAddress(0n);
            const normalRes = await blockchain.sendMessage(internal({
                from: nftAddr,
                to: collection.address,
                body: burnNotification(burnAmount, deployer.address, 0n),
                value: toNano('0.1')
            }));
            expect(normalRes.transactions).toHaveTransaction({
                from: nftAddr,
                to: collection.address,
                op: Op.burn_notification,
                success: true
            });
            expect(normalRes.transactions).toHaveTransaction({
                from: collection.address,
                to: deployer.address,
                op: Op.distributed_asset,
                success: true
            });
       });
       it("should not mint after distribution start", async () => {
           await loadSnapshot("distribution");
           const mintResult = await collection.sendMint(deployer.getSender(), randomAddress(), toNano(1000));
           expect(mintResult.transactions).toHaveTransaction({
               from: deployer.address,
               to: collection.address,
               success: false,
               exitCode: Errors.mint_after_distribution_start
           });
       });
       if (SLUGGISH_TESTS) {
         it("should mint high amount of NFTs", mintExtended);
         it("should distribute correctly among many NFT owners", async () => {
             await loadSnapshot("minted_extended");
             await distributeTONs(sharesExtended);
         });
       }
    });
    describe("Distributing Jettons", () => {
        beforeAll(async () => {
            initDistribution = {
                active: false,
                isJetton: true,
                volume: 0n,
                myJettonWallet: jwalletAddr
            }
        });
        it("should deploy collection with jetton distribution", deploy);
        it("should mint NFT", mint)
        it("should not start distribution of TONs", async () => {
            await loadSnapshot("minted");
            const sendStartResult = await collection.sendStartDistribution(deployer.getSender(), toNano(1000));
            expect(sendStartResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: collection.address,
                success: false,
                exitCode: Errors.cannot_distribute_tons
            });
        });
        it("should distribute Jettons", async () => {
            await loadSnapshot("minted");
            await distributeJettons(shares);
            snapshots.set("distributed", blockchain.snapshot());
        });
        it("should not distribute again", async () => {
            await loadSnapshot("distributed");
            const mintAssetResult = await poolJetton.sendMint(deployer.getSender(), collection.address, toNano("1000"), toNano("0.1"), toNano("0.5"))
            expect(mintAssetResult.transactions).toHaveTransaction({
                from: jwalletAddr,
                to: collection.address,
                op: Op.transfer_notification,
                success: false,
                exitCode: Errors.distribution_already_started
            });
        });
        if (SLUGGISH_TESTS) {
            it('should mint high amount of NFTs', mintExtended);
            it('should distribute Jettons correctly among many NFT owners', async () => {
                await loadSnapshot("minted_extended");
                await distributeJettons(sharesExtended);
            });
        }
    });
});
