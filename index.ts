/* eslint-env node */
import { config } from "dotenv";
import express, { Request, Response } from "express";
import { verify, settle } from "x402/facilitator";
import { ethers } from "ethers";
import {
  PaymentRequirementsSchema,
  type PaymentRequirements,
  type PaymentPayload,
  PaymentPayloadSchema,
  createConnectedClient,
  createSigner,
  SupportedEVMNetworks,
  SupportedSVMNetworks,
  Signer,
  ConnectedClient,
  SupportedPaymentKind,
  isSvmSignerWallet,
  type X402Config,
} from "x402/types";

config();

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || "";
const EVM_RPC_URL = process.env.EVM_RPC_URL || "https://sepolia.base.org"; // default RPC
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY || "";
const SVM_RPC_URL = process.env.SVM_RPC_URL || "";

if (!EVM_PRIVATE_KEY && !SVM_PRIVATE_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Create X402 config with custom RPC URL if provided
const x402Config: X402Config | undefined = SVM_RPC_URL
  ? { svmConfig: { rpcUrl: SVM_RPC_URL } }
  : undefined;

// -------------------- ERC20 HELPER --------------------
const ERC20_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
];

// -------------------- SEND CASHBACK --------------------
async function sendEvmCashback(to: string, tokenAddress: string, amount: number) {
  console.log("Send EVM cashback called:", { to, tokenAddress, amount });

  const provider = new ethers.JsonRpcProvider(EVM_RPC_URL);
  const wallet = new ethers.Wallet(EVM_PRIVATE_KEY, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  const decimals = await token.decimals().catch(() => 18);
  const decimalAmount = ethers.parseUnits(amount.toString(), decimals);

  console.log("Decimal Amount:", decimalAmount.toString());

  const tx = await token.transfer(to, decimalAmount);
  console.log(`⏳ Broadcasting cashback tx: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`💸 Sent ${amount} tokens to ${to} on EVM (tx: ${tx.hash})`);

  return tx.hash;
}

const app = express();

// Configure express to parse JSON bodies
app.use(express.json());

type VerifyRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

type SettleRequest = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

app.get("/verify", (req: Request, res: Response) => {
  res.json({
    endpoint: "/verify",
    description: "POST to verify x402 payments",
    body: {
      paymentPayload: "PaymentPayload",
      paymentRequirements: "PaymentRequirements",
    },
  });
});

app.post("/verify", async (req: Request, res: Response) => {
  try {
    const body: VerifyRequest = req.body;
    const paymentRequirements = PaymentRequirementsSchema.parse(body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(body.paymentPayload);

    // use the correct client/signer based on the requested network
    // svm verify requires a Signer because it signs & simulates the txn
    let client: Signer | ConnectedClient;
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      client = createConnectedClient(paymentRequirements.network);
    } else if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      client = await createSigner(paymentRequirements.network, SVM_PRIVATE_KEY);
    } else {
      throw new Error("Invalid network");
    }

    // verify
    const valid = await verify(client, paymentPayload, paymentRequirements, x402Config);
    res.json(valid);
  } catch (error) {
    console.error("error", error);
    res.status(400).json({ error: "Invalid request" });
  }
});

app.get("/settle", (req: Request, res: Response) => {
  res.json({
    endpoint: "/settle",
    description: "POST to settle x402 payments",
    body: {
      paymentPayload: "PaymentPayload",
      paymentRequirements: "PaymentRequirements",
    },
  });
});

app.get("/supported", async (req: Request, res: Response) => {
  let kinds: SupportedPaymentKind[] = [];

  // evm
  if (EVM_PRIVATE_KEY) {
    kinds.push({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
    });
  }

  // svm
  if (SVM_PRIVATE_KEY) {
    const signer = await createSigner("solana-devnet", SVM_PRIVATE_KEY);
    const feePayer = isSvmSignerWallet(signer) ? signer.address : undefined;

    kinds.push({
      x402Version: 1,
      scheme: "exact",
      network: "solana-devnet",
      extra: {
        feePayer,
      },
    });
  }
  res.json({
    kinds,
  });
});

app.post("/settle", async (req: Request, res: Response) => {
  try {
    const body: SettleRequest = req.body;
    const paymentRequirements = PaymentRequirementsSchema.parse(body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(body.paymentPayload);

    // use the correct private key based on the requested network
    let signer: Signer;
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      signer = await createSigner(paymentRequirements.network, EVM_PRIVATE_KEY);
    } else if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      signer = await createSigner(paymentRequirements.network, SVM_PRIVATE_KEY);
    } else {
      throw new Error("Invalid network");
    }

    const settlement = await settle(signer, paymentPayload, paymentRequirements, x402Config);
    console.log("✅ Settlement complete:", settlement);

    // Step 2: Cashback calculation
    const cashbackPercent = Number(process.env.CASHBACK_PERCENT || "2");
    const cashbackAmount = 1; // example static cashback
    let payer: string | undefined;

    if ("authorization" in paymentPayload.payload) {
      payer = paymentPayload.payload.authorization.from;
    }

    console.log(`💰 Cashback eligible: ${cashbackAmount} (${cashbackPercent}%)`);

    // Step 3: Send cashback
    let cashbackTxHash: string | null = null;

    if (payer && cashbackAmount > 0) {
      if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
        const tokenAddr = process.env.EVM_CASHBACK_TOKEN!;
        cashbackTxHash = await sendEvmCashback(payer, tokenAddr, cashbackAmount);
      } else if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
        console.log("🪙 Solana cashback not implemented yet.");
      }
    }

    // Step 4: Return
    res.json({
      success: true,
      settlement,
      cashback: {
        amount: cashbackAmount,
        txHash: cashbackTxHash,
        percent: cashbackPercent,
      },
    });
  } catch (error) {
    console.error("❌ Error in /settle:", error);
    res.status(400).json({ error: String(error) });
  }
});

// For local development
if (process.env.NODE_ENV !== "production") {
  app.listen(process.env.PORT || 3000, () => {
    console.log(`Server listening at http://localhost:${process.env.PORT || 3000}`);
  });
}

// Export for Vercel
export default app;
