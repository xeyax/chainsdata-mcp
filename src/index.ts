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

      // Session management with cleanup
      const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
        {};
      const sessionTimers: { [sessionId: string]: NodeJS.Timeout } = {};
      const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

      const cleanupSession = (sessionId: string) => {
        if (transports[sessionId]) {
          transports[sessionId].close?.();
          delete transports[sessionId];
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

      // Handle POST requests for client-to-server communication
      app.post("/mcp", async (req, res) => {
        try {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;

          if (sessionId && transports[sessionId]) {
            // Reuse existing transport and reset its timer
            transport = transports[sessionId];
            resetSessionTimer(sessionId);
          } else if (!sessionId && req.body.method === "initialize") {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sessionId) => {
                transports[sessionId] = transport;
                resetSessionTimer(sessionId);
                console.error(`New MCP session initialized: ${sessionId}`);
              },
            });

            // Clean up transport when closed
            transport.onclose = () => {
              if (transport.sessionId) {
                console.error(`MCP session closed: ${transport.sessionId}`);
                cleanupSession(transport.sessionId);
              }
            };

            const server = createServer();
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

      // Reusable handler for GET and DELETE requests
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

      // Handle GET requests for server-to-client notifications via SSE
      app.get("/mcp", handleSessionRequest);

      // Handle DELETE requests for session termination
      app.delete("/mcp", handleSessionRequest);

      // Health check endpoint
      app.get("/health", (req, res) => {
        const activeSessions = Object.keys(transports).length;
        res.json({
          status: "healthy",
          timestamp: new Date().toISOString(),
          activeSessions,
          supportedChains: Object.keys(chainMapping),
          version: "1.0.0",
        });
      });

      // Default route for API information
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

      // Global error handler
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

      // Graceful shutdown
      const shutdown = () => {
        console.error("Received shutdown signal, cleaning up...");

        // Clean up all sessions
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
