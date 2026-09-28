import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);
const ASSOCIATED_TOKEN = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const SYSTEM = SystemProgram.programId;
const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_PRIORITY_FEE_LAMPORTS = 5_000_000n;
const MAX_TRANSACTION_FEE_LAMPORTS = 5_100_000;
const SUPPORTED_JUPITER_SWAP_VARIANTS = new Set(Array.from({ length: 47 }, (_, index) => index));

function fail(reason) {
  throw new Error(`Unsafe swap transaction: ${reason}`);
}

function associatedTokenAddress(owner, mint, tokenProgram) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];
}

function decodeRoute(instruction, intent) {
  const data = Buffer.from(instruction.data);
  const routeDiscriminator = Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]);
  if (data.length < 8 + 4 + 4 + 19 || !data.subarray(0, 8).equals(routeDiscriminator)) {
    fail('unsupported Jupiter instruction');
  }
  const routeCount = data.readUInt32LE(8);
  if (routeCount < 1 || routeCount > 5 || data.length !== 12 + routeCount * 4 + 19) {
    fail('invalid or unsupported Jupiter route plan');
  }
  for (let index = 0; index < routeCount; index += 1) {
    const offset = 12 + index * 4;
    const swapVariant = data.readUInt8(offset);
    const percent = data.readUInt8(offset + 1);
    const inputIndex = data.readUInt8(offset + 2);
    const outputIndex = data.readUInt8(offset + 3);
    if (!SUPPORTED_JUPITER_SWAP_VARIANTS.has(swapVariant) || percent < 1 || percent > 100 ||
        inputIndex > routeCount || outputIndex > routeCount || inputIndex === outputIndex) {
      fail('unsupported or malformed Jupiter route step');
    }
  }
  const tail = data.length - 19;
  const inputAmount = data.readBigUInt64LE(tail);
  const quotedOutput = data.readBigUInt64LE(tail + 8);
  const slippageBps = data.readUInt16LE(tail + 16);
  const platformFeeBps = data.readUInt8(tail + 18);
  if (inputAmount !== BigInt(intent.inputAmount) || quotedOutput !== BigInt(intent.quotedOutput) ||
      slippageBps !== intent.slippageBps || quotedOutput <= 0n || slippageBps < 1 || slippageBps > 300 ||
      quotedOutput * BigInt(10_000 - slippageBps) / 10_000n < BigInt(intent.minimumOutput)) {
    fail('Jupiter route amounts or slippage do not match the reviewed quote');
  }
  if (platformFeeBps !== 0) fail('Jupiter platform fees are not allowed');
}

function validateInstruction(instruction, context) {
  const { wallet, inputMint, outputMint, inputTokenProgram, outputTokenProgram, intent } = context;
  const program = instruction.programId.toBase58();
  const keys = instruction.keys.map((key) => key.pubkey);
  const data = Buffer.from(instruction.data);

  if (instruction.programId.equals(COMPUTE_BUDGET)) {
    if (keys.length === 0 && data.length === 5 && data[0] === 2) {
      const units = data.readUInt32LE(1);
      if (units > MAX_COMPUTE_UNITS) fail('compute-unit limit exceeds policy');
      context.computeUnits = units;
      return;
    }
    if (keys.length === 0 && data.length === 9 && data[0] === 3) {
      context.priorityFee = (data.readBigUInt64LE(1) * BigInt(context.computeUnits) + 999_999n) / 1_000_000n;
      if (context.priorityFee > MAX_PRIORITY_FEE_LAMPORTS) fail('priority fee exceeds policy');
      return;
    }
    fail('unsupported compute-budget instruction');
  }

  if (instruction.programId.equals(ASSOCIATED_TOKEN)) {
    const metas = instruction.keys;
    if (!((data.length === 0) || (data.length === 1 && data[0] === 1)) || metas.length !== 6 ||
      !keys[0].equals(wallet) || !metas[0].isSigner || !metas[0].isWritable ||
      !keys[2].equals(wallet) || !metas[1].isWritable || metas[3].isSigner || metas[3].isWritable ||
      !keys[4].equals(SYSTEM) || metas[4].isSigner || metas[4].isWritable ||
      metas[5].isSigner || metas[5].isWritable) {
      fail('unsupported associated-token instruction or authority');
    }
    const mint = keys[3];
    const tokenProgram = keys[5];
    const expectedMint = mint.equals(inputMint) ? inputMint : mint.equals(outputMint) ? outputMint : null;
    const expectedProgram = mint.equals(inputMint) ? inputTokenProgram : mint.equals(outputMint) ? outputTokenProgram : null;
    if (!expectedMint || !expectedProgram || !tokenProgram.equals(expectedProgram) ||
        !keys[1].equals(associatedTokenAddress(wallet, mint, tokenProgram))) {
      fail('associated-token account is not owned by the wallet for a trade mint');
    }
    return;
  }

  if (TOKEN_PROGRAMS.has(program)) {
    if (!data.length) fail('empty token instruction');
    const wrappedSolAccount = associatedTokenAddress(wallet, new PublicKey(intent.wrappedSolMint), instruction.programId);
    if (data[0] === 17 && data.length === 1 && instruction.keys.length === 1 &&
      keys[0].equals(wrappedSolAccount) && instruction.keys[0].isWritable && !instruction.keys[0].isSigner) return;
    if (data[0] === 9 && data.length === 1 && instruction.keys.length === 3 && keys[0].equals(wrappedSolAccount) &&
      keys[1].equals(wallet) && instruction.keys[1].isWritable && !instruction.keys[1].isSigner &&
      keys[2].equals(wallet) && instruction.keys[2].isSigner &&
      instruction.keys[0].isWritable && !instruction.keys[0].isSigner) return;
    fail('unsupported token instruction or transfer authority');
  }

  if (instruction.programId.equals(SYSTEM)) {
    if (data.length === 12 && data.readUInt32LE(0) === 2 && instruction.keys.length === 2) {
      const amount = data.readBigUInt64LE(4);
      const wrappedSolAccount = associatedTokenAddress(wallet, new PublicKey(intent.wrappedSolMint), inputTokenProgram);
        if (context.wrappedSolTransfers !== 0 || !keys[0]?.equals(wallet) || !instruction.keys[0].isSigner ||
          !instruction.keys[0].isWritable || !keys[1]?.equals(wrappedSolAccount) ||
          instruction.keys[1].isSigner || !instruction.keys[1].isWritable || amount !== BigInt(intent.inputAmount)) {
        fail('unexpected system transfer, amount, or recipient');
      }
      context.wrappedSolTransfers += 1;
      return;
    }
    fail('unsupported system instruction');
  }

  if (instruction.programId.equals(JUPITER_V6)) {
    decodeRoute(instruction, intent);
    if (!instruction.keys.some((key) => key.isSigner && key.pubkey.equals(wallet))) {
      fail('Jupiter transfer authority is not the connected wallet');
    }
    const source = associatedTokenAddress(wallet, inputMint, inputTokenProgram);
    const destination = associatedTokenAddress(wallet, outputMint, outputTokenProgram);
    if (!keys.some((key) => key.equals(source)) || !keys.some((key) => key.equals(destination))) {
      fail('Jupiter source or destination is not the wallet trade-mint account');
    }
    return;
  }

  fail(`unsupported program ${program}`);
}

export async function validateSwapTransaction({
  swapTransaction,
  connection,
  walletPublicKey,
  inputMint,
  outputMint,
  inputAmount,
  quotedOutput,
  minimumOutput,
  slippageBps,
}) {
  if (typeof swapTransaction !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(swapTransaction)) {
    fail('invalid base64 transaction');
  }
  const wallet = new PublicKey(walletPublicKey);
  const inMint = new PublicKey(inputMint);
  const outMint = new PublicKey(outputMint);
  const wrappedSolMint = new PublicKey('So11111111111111111111111111111111111111112');
  const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  const tables = [];
  for (const lookup of transaction.message.addressTableLookups) {
    const result = await connection.getAddressLookupTable(lookup.accountKey);
    if (!result.value) fail(`address lookup table unavailable: ${lookup.accountKey.toBase58()}`);
    tables.push(result.value);
  }

  if (transaction.message.header.numRequiredSignatures !== 1 ||
      !transaction.message.staticAccountKeys[0]?.equals(wallet) ||
      transaction.signatures.some((signature) => signature.some((byte) => byte !== 0))) {
    fail('transaction must be unsigned and require only the connected wallet');
  }
  const message = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables });
  if (!message.payerKey.equals(wallet)) fail('fee payer does not match the connected wallet');
  const fee = await connection.getFeeForMessage(transaction.message, 'confirmed');
  if (!Number.isSafeInteger(fee?.value) || fee.value < 0 || fee.value > MAX_TRANSACTION_FEE_LAMPORTS) {
    fail('network transaction fee is unavailable or exceeds policy');
  }

  const tokenPrograms = [...TOKEN_PROGRAMS].map((id) => new PublicKey(id));
  const [inputMintInfo, outputMintInfo] = await Promise.all([
    connection.getAccountInfo(inMint),
    connection.getAccountInfo(outMint),
  ]);
  const inputTokenProgram = tokenPrograms.find((program) => program.equals(inputMintInfo?.owner));
  const outputTokenProgram = tokenPrograms.find((program) => program.equals(outputMintInfo?.owner));
  if (!inputTokenProgram || !outputTokenProgram) fail('mint account is unavailable or has an unsupported token program');
  const context = {
    wallet,
    inputMint: inMint,
    outputMint: outMint,
    inputTokenProgram,
    outputTokenProgram,
    computeUnits: MAX_COMPUTE_UNITS,
    priorityFee: 0n,
    wrappedSolTransfers: 0,
    intent: {
      inputAmount: String(inputAmount),
      quotedOutput: String(quotedOutput),
      minimumOutput: String(minimumOutput),
      slippageBps,
      wrappedSolMint: wrappedSolMint.toBase58(),
    },
  };
  let routes = 0;
  for (const instruction of message.instructions) {
    validateInstruction(instruction, context);
    if (instruction.programId.equals(JUPITER_V6)) routes += 1;
  }
  if (routes !== 1) fail('expected exactly one supported Jupiter exact-in route');
  if (inMint.equals(wrappedSolMint) && context.wrappedSolTransfers > 1) {
    fail('unexpected wrapped-SOL funding transfer count');
  }
  return { priorityFeeLamports: String(context.priorityFee), transactionFeeLamports: fee.value };
}