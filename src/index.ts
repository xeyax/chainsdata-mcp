import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fs from "fs";
import path from "path";
import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";

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
  const filePath = path.join("token-lists", filename);
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

async function main() {
  try {
    const useHttp = process.argv.includes("--http");

    if (useHttp) {
      const app = express();
      const port = Number(process.env.PORT) || 3000;

      app.use(express.json());

      // CORS headers for remote access
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

      // Map to store transports by session ID
      const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
        {};

      // Handle POST requests for client-to-server communication
      app.post("/mcp", async (req, res) => {
        // Check for existing session ID
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

        // Handle the request
        await transport.handleRequest(req, res, req.body);
      });

      // Reusable handler for GET and DELETE requests
      const handleSessionRequest = async (
        req: express.Request,
        res: express.Response,
      ) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !transports[sessionId]) {
          res.status(400).send("Invalid or missing session ID");
          return;
        }

        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
      };

      // Handle GET requests for server-to-client notifications via SSE
      app.get("/mcp", handleSessionRequest);

      // Handle DELETE requests for session termination
      app.delete("/mcp", handleSessionRequest);

      app.listen(port, "0.0.0.0", () => {
        console.error(`ChainsData MCP server running on HTTP port ${port}`);
        console.error(`Remote access URL: http://localhost:${port}/mcp`);
      });
    } else {
      // Stdio mode
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
