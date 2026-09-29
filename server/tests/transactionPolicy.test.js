import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { validateSwapTransaction } from '../../src/solana/validateSwapTransaction.js';

const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associatedTokenProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const jupiterProgram = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const associatedProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const wrappedSol = new PublicKey('So11111111111111111111111111111111111111112');

function tokenAddress(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    associatedTokenProgram,
  )[0];
}

function routeTransaction(owner, outputMint, {
  amount = 10_000_000n,
  output = 10n,
  slippage = 100,
  feeBps = 0,
  createOutputAccount = false,
  swapVariant = 0,
  percent = 100,
  inputIndex = 0,
  outputIndex = 1,
  extraBytes = 0,
} = {}) {
  const data = Buffer.alloc(35 + extraBytes);
  Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]).copy(data);
  data.writeUInt32LE(1, 8);
  data[12] = 0;
  data[13] = percent;
  data[14] = inputIndex;
  data[15] = outputIndex;
  data.writeBigUInt64LE(amount, 16);
  data.writeBigUInt64LE(output, 24);
  data.writeUInt16LE(slippage, 32);
  data[34] = feeBps;
  data[12] = swapVariant;
  return new VersionedTransaction(new TransactionMessage({
    payerKey: owner,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      ...(createOutputAccount ? [new TransactionInstruction({
        programId: associatedProgram,
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: tokenAddress(owner, outputMint), isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: outputMint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: Buffer.alloc(0),
      })] : []),
      new TransactionInstruction({
      programId: jupiterProgram,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: tokenAddress(owner, wrappedSol), isSigner: false, isWritable: true },
        { pubkey: tokenAddress(owner, outputMint), isSigner: false, isWritable: true },
        { pubkey: wrappedSol, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data,
      }),
    ],
  }).compileToV0Message());
}

function feeConnection(fee = 5000) {
  return {
    getAddressLookupTable: async () => ({ value: null }),
    getAccountInfo: async () => ({ owner: tokenProgram }),
    getFeeForMessage: async () => ({ value: fee }),
  };
}

test('rejects an unsigned transfer to an unrelated recipient before signing', async () => {
  const wallet = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    })],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);

  await assert.rejects(validateSwapTransaction({
    swapTransaction: Buffer.from(transaction.serialize()).toString('base64'),
    connection: { ...feeConnection(), getAccountInfo: async () => ({ owner: tokenProgram }) },
    walletPublicKey: wallet.publicKey.toBase58(),
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: Keypair.generate().publicKey.toBase58(),
    inputAmount: '1000000',
    quotedOutput: '10',
    slippageBps: 100,
  }), /unexpected system transfer/);
});

test('accepts a matching Jupiter route after resolving a versioned lookup table', async () => {
  const owner = Keypair.generate();
  const outputMint = Keypair.generate().publicKey;
  const lookupTable = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: 18446744073709551615n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [outputMint],
    },
  });
  const intent = {
    connection: { ...feeConnection(), getAddressLookupTable: async key => ({ value: key.equals(lookupTable.key) ? lookupTable : null }) },
    walletPublicKey: owner.publicKey.toBase58(),
    inputMint: wrappedSol.toBase58(),
    outputMint: outputMint.toBase58(),
    inputAmount: '10000000',
    quotedOutput: '10',
    minimumOutput: '9',
    slippageBps: 100,
  };
  const valid = routeTransaction(owner.publicKey, outputMint, { createOutputAccount: true });
  const lookupMessage = TransactionMessage.decompile(valid.message);
  const versioned = new VersionedTransaction(lookupMessage.compileToV0Message([lookupTable]));
  assert.equal((await validateSwapTransaction({
    ...intent,
    swapTransaction: Buffer.from(versioned.serialize()).toString('base64'),
  })).transactionFeeLamports, 5000);

  await assert.rejects(validateSwapTransaction({
    ...intent,
    connection: { ...intent.connection, getAddressLookupTable: async () => ({ value: null }) },
    swapTransaction: Buffer.from(versioned.serialize()).toString('base64'),
  }), /address lookup table unavailable/);

  for (const changes of [
    { amount: 9_000_000n },
    { output: 11n },
    { slippage: 200 },
    { feeBps: 1 },
    { swapVariant: 255 },
    { percent: 0 },
    { outputIndex: 2 },
    { extraBytes: 1 },
  ]) {
    const changed = routeTransaction(owner.publicKey, outputMint, changes);
    await assert.rejects(validateSwapTransaction({
      ...intent,
      swapTransaction: Buffer.from(changed.serialize()).toString('base64'),
    }), /Unsafe swap transaction/);
  }
  await assert.rejects(validateSwapTransaction({
    ...intent,
    connection: { ...intent.connection, getFeeForMessage: async () => ({ value: 5_100_001 }) },
    swapTransaction: Buffer.from(versioned.serialize()).toString('base64'),
  }), /network transaction fee/);
});