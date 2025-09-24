import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";

config();

const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
if (!GRAPH_API_KEY) {
  console.warn(
    "Warning: GRAPH_API_KEY not set. Using public endpoint (may have rate limits)",
  );
}

interface Token {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
}

interface TokenList {
  name: string;
  tokens: Token[];
}

interface UniswapV3Token {
  id: string;
  symbol: string;
  name: string;
  decimals: string;
}

interface UniswapV3Pool {
  id: string;
  feeTier: string;
  token0: UniswapV3Token;
  token1: UniswapV3Token;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
}

interface UniswapV3PoolsResponse {
  pools: UniswapV3Pool[];
}

interface SubgraphResponse {
  data: UniswapV3PoolsResponse;
  errors?: Array<{ message: string }>;
}

interface AerodromeToken {
  id: string;
  symbol: string;
  name: string;
  decimals: string;
}

interface AerodromePool {
  id: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
  token0: AerodromeToken;
  token1: AerodromeToken;
}

interface AerodromePoolsResponse {
  pools: AerodromePool[];
}

interface AerodromeSubgraphResponse {
  data: AerodromePoolsResponse;
  errors?: Array<{ message: string }>;
}

interface ChainlinkFeed {
  name: string;
  proxyAddress: string;
  feedCategory: string;
}

interface ChainData {
  baseUrl: string;
  feeds: ChainlinkFeed[];
}

interface FeedsData {
  [chainName: string]: ChainData;
}

function readTokenList(listName: string, chainId: number): TokenList {
  const filename = `${listName}.${chainId}.json`;
  const filePath = path.join(process.cwd(), "token-lists", filename);

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return JSON.parse(fileContent) as TokenList;
  } catch (error) {
    throw new Error(
      `Failed to read token list ${filename}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

function readFeedsData(): FeedsData {
  const filePath = path.join(process.cwd(), "feeds.json");

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return JSON.parse(fileContent) as FeedsData;
  } catch (error) {
    throw new Error(
      `Failed to read feeds.json: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

const chainMapping: Record<string, number> = {
  Ethereum: 1,
  "BNB Smart Chain": 56,
  Gnosis: 100,
  Polygon: 137,
  Arbitrum: 42161,
  Base: 8453,
};

const uniswapV3SubgraphMapping: Record<string, string> = {
  Ethereum: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
  Polygon: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm",
  Base: "HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1",
  Arbitrum: "3V7ZY6muhxaQL5qvntX1CFXJ32W7BxXZTGTwmpH5J4t3",
};

const supportedUniswapChains = Object.keys(uniswapV3SubgraphMapping);

const aerodromeSubgraphMapping: Record<string, string> = {
  Base: "GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM",
};

const supportedAerodromeChains = Object.keys(aerodromeSubgraphMapping);

function findTokensBySymbols(
  symbols: string[],
  chain: string = "Ethereum",
  list: string = "Coingecko",
): { tokens: Token[]; notFound?: string } {
  if (!symbols || symbols.length === 0) {
    throw new Error("Symbols array cannot be empty");
  }

  const chainId = chainMapping[chain];
  if (!chainId) {
    throw new Error(
      `Unsupported chain: ${chain}. Supported chains: ${Object.keys(chainMapping).join(", ")}`,
    );
  }

  const tokenList = readTokenList(list, chainId);

  const foundTokens: Token[] = [];
  const notFoundSymbols: string[] = [];

  for (const symbol of symbols) {
    if (typeof symbol !== "string" || symbol.trim() === "") {
      notFoundSymbols.push(String(symbol));
      continue;
    }

    const token = tokenList.tokens.find(
      (t) => t.symbol.toLowerCase() === symbol.toLowerCase(),
    );
    if (token) {
      foundTokens.push(token);
    } else {
      notFoundSymbols.push(symbol);
    }
  }

  const result: { tokens: Token[]; notFound?: string } = {
    tokens: foundTokens,
  };

  if (notFoundSymbols.length > 0) {
    result.notFound = notFoundSymbols.join(", ");
  }

  return result;
}

const UNISWAP_V3_POOLS_QUERY = `
  query GetPools($token0Symbol: String, $token1Symbol: String, $token0Name: String, $token1Name: String) {
    pools(
      first: 100,
      orderBy: totalValueLockedUSD,
      orderDirection: desc,
      where: {
        or: [
          {
            and: [
              {
                or: [
                  { token0_: { symbol_contains_nocase: $token0Symbol } },
                  { token0_: { name_contains_nocase: $token0Name } }
                ]
              },
              {
                or: [
                  { token1_: { symbol_contains_nocase: $token1Symbol } },
                  { token1_: { name_contains_nocase: $token1Name } }
                ]
              }
            ]
          },
          {
            and: [
              {
                or: [
                  { token0_: { symbol_contains_nocase: $token1Symbol } },
                  { token0_: { name_contains_nocase: $token1Name } }
                ]
              },
              {
                or: [
                  { token1_: { symbol_contains_nocase: $token0Symbol } },
                  { token1_: { name_contains_nocase: $token0Name } }
                ]
              }
            ]
          }
        ]
      }
    ) {
      id
      feeTier
      totalValueLockedUSD
      volumeUSD
      txCount
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
    }
  }
`;

const AERODROME_POOLS_QUERY = `
  query GetAerodromePools($token0Symbol: String, $token1Symbol: String, $token0Name: String, $token1Name: String) {
    pools(
      first: 50,
      orderBy: totalValueLockedUSD,
      orderDirection: desc,
      where: {
        or: [
          {
            and: [
              {
                or: [
                  { token0_: { symbol_contains_nocase: $token0Symbol } },
                  { token0_: { name_contains_nocase: $token0Name } }
                ]
              },
              {
                or: [
                  { token1_: { symbol_contains_nocase: $token1Symbol } },
                  { token1_: { name_contains_nocase: $token1Name } }
                ]
              }
            ]
          },
          {
            and: [
              {
                or: [
                  { token0_: { symbol_contains_nocase: $token1Symbol } },
                  { token0_: { name_contains_nocase: $token1Name } }
                ]
              },
              {
                or: [
                  { token1_: { symbol_contains_nocase: $token0Symbol } },
                  { token1_: { name_contains_nocase: $token0Name } }
                ]
              }
            ]
          }
        ]
      }
    ) {
      id
      totalValueLockedUSD
      volumeUSD
      txCount
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
    }
  }
`;

async function querySubgraph(
  query: string,
  variables: Record<string, any>,
  chainSubgraphId: string,
  retries = 3,
): Promise<any> {
  const baseUrl = GRAPH_API_KEY
    ? `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${chainSubgraphId}`
    : `https://api.thegraph.com/subgraphs/id/${chainSubgraphId}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: any = await response.json();

      if (data.errors && data.errors.length > 0) {
        throw new Error(
          `GraphQL errors: ${data.errors.map((e: any) => e.message).join(", ")}`,
        );
      }

      return data;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);

      if (attempt === retries) {
        throw new Error(
          `Failed to query subgraph after ${retries} attempts: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
      );
    }
  }

  throw new Error("Unexpected error in querySubgraph");
}

async function findUniswapV3Pools(
  token0: string,
  token1: string,
  chain: string = "Ethereum",
): Promise<{
  pools: UniswapV3Pool[];
  metadata: { chain: string; totalResults: number };
}> {
  if (!token0 || !token1) {
    throw new Error("Both token0 and token1 parameters are required");
  }

  if (typeof token0 !== "string" || typeof token1 !== "string") {
    throw new Error("Token parameters must be strings");
  }

  const normalizedToken0 = token0.trim();
  const normalizedToken1 = token1.trim();

  if (normalizedToken0 === "" || normalizedToken1 === "") {
    throw new Error("Token parameters cannot be empty");
  }

  if (!supportedUniswapChains.includes(chain)) {
    throw new Error(
      `Uniswap V3 not supported on ${chain}. Supported chains: ${supportedUniswapChains.join(", ")}`,
    );
  }

  const subgraphId = uniswapV3SubgraphMapping[chain];

  try {
    const response = await querySubgraph(
      UNISWAP_V3_POOLS_QUERY,
      {
        token0Symbol: normalizedToken0,
        token1Symbol: normalizedToken1,
        token0Name: normalizedToken0,
        token1Name: normalizedToken1,
      },
      subgraphId,
    );

    const pools = response.data.pools || [];

    const filteredPools = pools.filter((pool: any) => {
      const tvl = parseFloat(pool.totalValueLockedUSD);
      return tvl > 1000;
    });

    return {
      pools: filteredPools,
      metadata: {
        chain,
        totalResults: filteredPools.length,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch Uniswap V3 pools: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

async function findAerodromePools(
  token0: string,
  token1: string,
): Promise<{
  pools: AerodromePool[];
  metadata: { chain: string; totalResults: number };
}> {
  if (!token0 || !token1) {
    throw new Error("Both token0 and token1 parameters are required");
  }

  if (typeof token0 !== "string" || typeof token1 !== "string") {
    throw new Error("Token parameters must be strings");
  }

  const normalizedToken0 = token0.trim();
  const normalizedToken1 = token1.trim();

  if (normalizedToken0 === "" || normalizedToken1 === "") {
    throw new Error("Token parameters cannot be empty");
  }

  const chain = "Base";
  const subgraphId = aerodromeSubgraphMapping[chain];

  try {
    const response = await querySubgraph(
      AERODROME_POOLS_QUERY,
      {
        token0Symbol: normalizedToken0,
        token1Symbol: normalizedToken1,
        token0Name: normalizedToken0,
        token1Name: normalizedToken1,
      },
      subgraphId,
    );

    const pools = response.data.pools || [];

    const filteredPools = pools.filter((pool: AerodromePool) => {
      const tvl = parseFloat(pool.totalValueLockedUSD);
      return tvl > 1000;
    });

    return {
      pools: filteredPools,
      metadata: {
        chain,
        totalResults: filteredPools.length,
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch Aerodrome pools: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

function getSupportedChains(): { supportedChains: string[] } {
  const feedsData = readFeedsData();
  return {
    supportedChains: Object.keys(feedsData),
  };
}

function getFeedAddresses(
  pairs: string[],
  chain?: string,
): {
  feeds: Array<{
    name: string;
    proxyAddress: string;
    feedCategory: string;
    chain: string;
  }>;
  notFound?: string;
} {
  if (!pairs || pairs.length === 0) {
    throw new Error("Pairs array cannot be empty");
  }

  const feedsData = readFeedsData();
  const foundFeeds: Array<{
    name: string;
    proxyAddress: string;
    feedCategory: string;
    chain: string;
  }> = [];
  const notFoundPairs: string[] = [];

  if (chain) {
    const normalizedChain = chain.toLowerCase();
    if (!feedsData[normalizedChain]) {
      throw new Error(
        `Unsupported chain: ${chain}. Supported chains: ${Object.keys(feedsData).join(", ")}`,
      );
    }

    const chainData = feedsData[normalizedChain];
    for (const pair of pairs) {
      if (typeof pair !== "string" || pair.trim() === "") {
        notFoundPairs.push(String(pair));
        continue;
      }

      const feed = chainData.feeds.find(
        (f) => f.name.toLowerCase() === pair.toLowerCase(),
      );
      if (feed) {
        foundFeeds.push({
          ...feed,
          chain: normalizedChain,
        });
      } else {
        notFoundPairs.push(pair);
      }
    }
  } else {
    for (const pair of pairs) {
      if (typeof pair !== "string" || pair.trim() === "") {
        notFoundPairs.push(String(pair));
        continue;
      }

      let found = false;
      for (const [chainName, chainData] of Object.entries(feedsData)) {
        const feed = chainData.feeds.find(
          (f) => f.name.toLowerCase() === pair.toLowerCase(),
        );
        if (feed) {
          foundFeeds.push({
            ...feed,
            chain: chainName,
          });
          found = true;
          break;
        }
      }

      if (!found) {
        notFoundPairs.push(pair);
      }
    }
  }

  const result: {
    feeds: Array<{
      name: string;
      proxyAddress: string;
      feedCategory: string;
      chain: string;
    }>;
    notFound?: string;
  } = {
    feeds: foundFeeds,
  };

  if (notFoundPairs.length > 0) {
    result.notFound = notFoundPairs.join(", ");
  }

  return result;
}

function getSupportedFeedsByChain(chain: string): {
  chain: string;
  supportedFeeds: string[];
} {
  if (!chain || typeof chain !== "string" || chain.trim() === "") {
    throw new Error("Chain parameter is required and cannot be empty");
  }

  const feedsData = readFeedsData();

  const normalizedChain = chain.toLowerCase();
  if (!feedsData[normalizedChain]) {
    throw new Error(
      `Unsupported chain: ${chain}. Supported chains: ${Object.keys(feedsData).join(", ")}`,
    );
  }

  const chainData = feedsData[normalizedChain];
  const supportedFeeds = chainData.feeds.map((feed) => feed.name);

  return {
    chain: normalizedChain,
    supportedFeeds,
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "chainsdata-mcp",
    version: "1.0.0",
  });

  console.log("Starting tool registration...");

  try {
    console.log("Registering getTokensBySymbols tool...");
    server.registerTool(
      "getTokensBySymbols",
      {
        title: "Get Tokens by Symbols",
        description: "Get token information by symbols from token lists",
        inputSchema: {
          symbols: z
            .array(z.string())
            .describe("Array of token symbols to search for"),
          chain: z
            .string()
            .optional()
            .describe("Chain name (optional, default: 'Ethereum')"),
          list: z
            .string()
            .optional()
            .describe("Token list name (optional, default: 'Coingecko')"),
        },
      },
      async ({ symbols, chain, list }) => {
        try {
          const result = findTokensBySymbols(symbols, chain, list);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: errorMessage }, null, 2),
              },
            ],
            isError: true,
          };
        }
      },
    );
    console.log("✔ getTokensBySymbols tool registered successfully");
  } catch (error) {
    console.error("✗ Failed to register getTokensBySymbols tool:", error);
    throw error;
  }

  try {
    console.log("Registering getUniswapV3Pools tool...");
    server.registerTool(
      "getUniswapV3Pools",
      {
        title: "Get Uniswap V3 Pools",
        description:
          "Find Uniswap V3 liquidity pools by token pairs using The Graph Protocol",
        inputSchema: {
          token0: z
            .string()
            .describe("First token symbol or name (e.g., 'WETH', 'tBTC')"),
          token1: z
            .string()
            .describe("Second token symbol or name (e.g., 'USDC', 'DAI')"),
          chain: z
            .string()
            .optional()
            .default("Ethereum")
            .describe(
              `Chain name (optional, default: 'Ethereum'). Supported: ${supportedUniswapChains.join(", ")}`,
            ),
        },
      },
      async ({ token0, token1, chain }) => {
        try {
          const result = await findUniswapV3Pools(token0, token1, chain);

          const formattedResult = {
            ...result,
            searchCriteria: {
              token0,
              token1,
              chain,
            },
            timestamp: new Date().toISOString(),
            apiInfo: {
              source: "The Graph Protocol",
              subgraph: "Uniswap V3",
              endpoint: GRAPH_API_KEY ? "Authenticated Gateway" : "Public API",
            },
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(formattedResult, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: errorMessage,
                    searchCriteria: { token0, token1, chain },
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );
    console.log("✔ getUniswapV3Pools tool registered successfully");
  } catch (error) {
    console.error("✗ Failed to register getUniswapV3Pools tool:", error);
    throw error;
  }

  try {
    console.log("Registering getAerodromePools tool...");
    server.registerTool(
      "getAerodromePools",
      {
        title: "Get Aerodrome Pools",
        description:
          "Find Aerodrome liquidity pools by token pairs on Base chain using The Graph Protocol",
        inputSchema: {
          token0: z
            .string()
            .describe("First token symbol or name (e.g., 'WETH', 'USDC')"),
          token1: z
            .string()
            .describe("Second token symbol or name (e.g., 'DAI', 'AERO')"),
        },
      },
      async ({ token0, token1 }) => {
        try {
          const result = await findAerodromePools(token0, token1);

          const formattedResult = {
            ...result,
            searchCriteria: {
              token0,
              token1,
              chain: "Base",
            },
            timestamp: new Date().toISOString(),
            apiInfo: {
              source: "The Graph Protocol",
              subgraph: "Aerodrome",
              endpoint: GRAPH_API_KEY ? "Authenticated Gateway" : "Public API",
            },
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(formattedResult, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: errorMessage,
                    searchCriteria: { token0, token1, chain: "Base" },
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );
    console.log("✔ getAerodromePools tool registered successfully");
  } catch (error) {
    console.error("✗ Failed to register getAerodromePools tool:", error);
    throw error;
  }

  try {
    console.log("Registering getSupportedChains tool...");
    server.registerTool(
      "getSupportedChains",
      {
        title: "Get Supported Chains",
        description: "Get list of supported chains for Chainlink feeds",
        inputSchema: {},
      },
      async () => {
        try {
          const result = getSupportedChains();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: errorMessage }, null, 2),
              },
            ],
            isError: true,
          };
        }
      },
    );
    console.log("✔ getSupportedChains tool registered successfully");
  } catch (error) {
    console.error("✗ Failed to register getSupportedChains tool:", error);
    throw error;
  }

  try {
    console.log("Registering getFeedAddresses tool...");
    server.registerTool(
      "getFeedAddresses",
      {
        title: "Get Feed Addresses",
        description: "Get Chainlink feed addresses by token pairs",
        inputSchema: {
          pairs: z
            .array(z.string())
            .describe(
              'Array of token pairs to search for (e.g., ["BRL/USD", "ETH/USD"])',
            ),
          chain: z
            .string()
            .optional()
            .describe(
              "Chain name (optional, searches all chains if not specified)",
            ),
        },
      },
      async ({ pairs, chain }) => {
        try {
          const result = getFeedAddresses(pairs, chain);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: errorMessage }, null, 2),
              },
            ],
            isError: true,
          };
        }
      },
    );
    console.log("✔ getFeedAddresses tool registered successfully");
  } catch (error) {
    console.error("✗ Failed to register getFeedAddresses tool:", error);
    throw error;
  }

  try {
    console.log("Registering getSupportedFeedsByChain tool...");
    server.registerTool(
      "getSupportedFeedsByChain",
      {
        title: "Get Supported Feeds by Chain",
        description:
          "Get list of all supported feed pairs for a specific chain",
        inputSchema: {
          chain: z.string().describe("Chain name (required)"),
        },
      },
      async ({ chain }) => {
        try {
          const result = getSupportedFeedsByChain(chain);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: errorMessage }, null, 2),
              },
            ],
            isError: true,
          };
        }
      },
    );
    console.log("✔ getSupportedFeedsByChain tool registered successfully");
  } catch (error) {
    console.error("✗ Failed to register getSupportedFeedsByChain tool:", error);
    throw error;
  }

  console.log("All tools registered successfully!");
  return server;
}

async function main() {
  try {
    const useStdio = process.argv.includes("--stdio");
    const useHttp = !useStdio;

    if (useHttp) {
      const app = express();
      const port = Number(process.env.PORT) || 3000;

      app.use(express.json());

      app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, MCP-Session-Id",
        );
        res.header("Access-Control-Expose-Headers", "MCP-Session-Id");

        if (req.method === "OPTIONS") {
          res.sendStatus(200);
          return;
        }
        next();
      });

      const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
        {};
      const servers: { [sessionId: string]: McpServer } = {};
      const sessionTimers: { [sessionId: string]: NodeJS.Timeout } = {};
      const SESSION_TIMEOUT = 30 * 60 * 1000;

      const cleanupSession = (sessionId: string) => {
        if (transports[sessionId]) {
          transports[sessionId].close?.();
          delete transports[sessionId];
        }
        if (servers[sessionId]) {
          servers[sessionId].close?.();
          delete servers[sessionId];
        }
        if (sessionTimers[sessionId]) {
          clearTimeout(sessionTimers[sessionId]);
          delete sessionTimers[sessionId];
        }
      };

      const resetSessionTimer = (sessionId: string) => {
        if (sessionTimers[sessionId]) {
          clearTimeout(sessionTimers[sessionId]);
        }
        sessionTimers[sessionId] = setTimeout(() => {
          console.error(`Session ${sessionId} expired due to inactivity`);
          cleanupSession(sessionId);
        }, SESSION_TIMEOUT);
      };

      app.post("/mcp", async (req, res) => {
        try {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;
          let server: McpServer;

          if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
            resetSessionTimer(sessionId);
          } else if (!sessionId && isInitializeRequest(req.body)) {
            server = createServer();

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sessionId) => {
                transports[sessionId] = transport;
                servers[sessionId] = server;
                resetSessionTimer(sessionId);
                console.error(`New MCP session initialized: ${sessionId}`);
              },
            });

            transport.onclose = () => {
              if (transport.sessionId) {
                console.error(`MCP session closed: ${transport.sessionId}`);
                cleanupSession(transport.sessionId);
              }
            };

            await server.connect(transport);
          } else {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Bad Request: No valid session ID provided or not an initialize request",
              },
              id: null,
            });
            return;
          }

          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("Error handling MCP request:", error);
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal error",
              data: error instanceof Error ? error.message : "Unknown error",
            },
            id: null,
          });
        }
      });

      const handleSessionRequest = async (
        req: express.Request,
        res: express.Response,
      ) => {
        try {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          if (!sessionId || !transports[sessionId]) {
            res.status(400).json({
              error: "Invalid or missing session ID",
              sessionId: sessionId || "missing",
            });
            return;
          }

          const transport = transports[sessionId];
          resetSessionTimer(sessionId);
          await transport.handleRequest(req, res);
        } catch (error) {
          console.error("Error handling session request:", error);
          res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? error.message : "Unknown error",
          });
        }
      };

      app.get("/mcp", handleSessionRequest);

      app.delete("/mcp", handleSessionRequest);

      app.get("/health", (req, res) => {
        const activeSessions = Object.keys(transports).length;

        const expectedTools = [
          "getTokensBySymbols",
          "getUniswapV3Pools",
          "getAerodromePools",
          "getSupportedChains",
          "getFeedAddresses",
          "getSupportedFeedsByChain",
        ];

        let registeredTools = expectedTools;

        res.json({
          status: "healthy",
          timestamp: new Date().toISOString(),
          activeSessions,
          supportedChains: Object.keys(chainMapping),
          uniswapV3Chains: supportedUniswapChains,
          tools: registeredTools,
          version: "1.0.0",
          graphApiKeyConfigured: !!GRAPH_API_KEY,
        });
      });

      app.get("/", (req, res) => {
        res.json({
          name: "ChainsData MCP Server",
          description:
            "Model Context Protocol server for blockchain token data",
          version: "1.0.0",
          endpoints: {
            mcp: "/mcp",
            health: "/health",
          },
          supportedChains: Object.keys(chainMapping),
        });
      });

      app.use(
        (
          error: Error,
          req: express.Request,
          res: express.Response,
          next: express.NextFunction,
        ) => {
          console.error("Unhandled Express error:", error);
          res.status(500).json({
            error: "Internal server error",
            message: error.message,
          });
        },
      );

      const server = app.listen(port, "0.0.0.0", () => {
        console.error(`ChainsData MCP server running on HTTP port ${port}`);
        console.error(`Health check: http://localhost:${port}/health`);
        console.error(`MCP endpoint: http://localhost:${port}/mcp`);
      });

      const shutdown = () => {
        console.error("Received shutdown signal, cleaning up...");

        Object.keys(transports).forEach((sessionId) => {
          cleanupSession(sessionId);
        });

        server.close(() => {
          console.error("HTTP server closed");
          process.exit(0);
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      const server = createServer();
      const transport = new StdioServerTransport();

      process.on("SIGINT", async () => {
        await transport.close();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        await transport.close();
        process.exit(0);
      });

      await server.connect(transport);
      console.error("ChainsData MCP server running on stdio");
    }
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
