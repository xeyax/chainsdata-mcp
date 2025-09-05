import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Token interface
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

function readTokenList(listName: string, chainId: number): TokenList {
  const filename = `${listName}.${chainId}.json`;
  const filePath = path.join(process.cwd(), "token-lists", filename);
  const fileContent = fs.readFileSync(filePath, "utf8");
  return JSON.parse(fileContent) as TokenList;
}

const chainMapping: Record<string, number> = {
  Ethereum: 1,
  "BNB Smart Chain": 56,
  Gnosis: 100,
  Polygon: 137,
  Arbitrum: 42161,
  Base: 8453,
};

function findTokensBySymbols(
  symbols: string[],
  chain: string = "Ethereum",
  list: string = "Coingecko",
): { tokens: Token[]; notFound?: string } {
  const chainId = chainMapping[chain];
  const tokenList = readTokenList(list, chainId);

  const foundTokens: Token[] = [];
  const notFoundSymbols: string[] = [];

  for (const symbol of symbols) {
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

// Global transport store for session management
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

function createServer(): McpServer {
  const server = new McpServer({
    name: "chainsdata-mcp",
    version: "1.0.0",
  });

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
      const result = findTokensBySymbols(symbols, chain, list);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, MCP-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    if (req.method === "POST") {
      // Handle POST requests for client-to-server communication
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && req.body.method === "initialize") {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            // Store the transport by session ID
            transports[sessionId] = transport;
          },
        });

        // Clean up transport when closed
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        const server = createServer();
        await server.connect(transport);
      } else {
        // Invalid request
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

      // Handle the request using the transport
      await transport.handleRequest(req, res, req.body);
    } else if (req.method === "GET") {
      // Handle GET requests for server-to-client notifications via SSE
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
      // Handle DELETE requests for session termination
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } else {
      res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    console.error("MCP server error:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
