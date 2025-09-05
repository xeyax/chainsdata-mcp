import fs from "fs";
import path from "path";

const chainMapping = {
  Ethereum: 1,
  "BNB Smart Chain": 56,
  Gnosis: 100,
  Polygon: 137,
  Arbitrum: 42161,
  Base: 8453,
};

function readTokenList(listName, chainId) {
  const filename = `${listName}.${chainId}.json`;
  const filePath = path.join(process.cwd(), "token-lists", filename);
  const fileContent = fs.readFileSync(filePath, "utf8");
  return JSON.parse(fileContent);
}

function findTokensBySymbols(symbols, chain = "Ethereum", list = "Coingecko") {
  const chainId = chainMapping[chain];
  if (!chainId) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  const tokenList = readTokenList(list, chainId);
  const foundTokens = [];
  const notFoundSymbols = [];

  for (const symbol of symbols) {
    const token = tokenList.tokens.find(
      (t) => t.symbol.toLowerCase() === symbol.toLowerCase()
    );
    if (token) {
      foundTokens.push(token);
    } else {
      notFoundSymbols.push(symbol);
    }
  }

  const result = { tokens: foundTokens };
  if (notFoundSymbols.length > 0) {
    result.notFound = notFoundSymbols.join(", ");
  }

  return result;
}

export default function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "POST") {
    try {
      const { symbols, chain, list } = req.body;

      if (!symbols || !Array.isArray(symbols)) {
        return res.status(400).json({
          error: "symbols parameter is required and must be an array"
        });
      }

      const result = findTokensBySymbols(symbols, chain, list);
      res.status(200).json(result);
    } catch (error) {
      console.error("Error processing request:", error);
      res.status(500).json({ error: error.message });
    }
  } else if (req.method === "GET") {
    // Health check endpoint
    res.status(200).json({
      message: "Chains Data API is running",
      supportedChains: Object.keys(chainMapping),
      usage: "POST with { symbols: [string[]], chain?: string, list?: string }"
    });
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
}
