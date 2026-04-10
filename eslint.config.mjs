import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import importX from "eslint-plugin-import-x";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Base configs
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintComments.recommended,
  prettier, // Must be last base config — disables formatting rules that conflict with Prettier

  // Global settings
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "import-x": importX,
    },
  },

  // === Project-wide rules ===
  {
    rules: {
      // -- Searchability --
      // Named exports make code greppable and refactor-safe
      "import-x/no-default-export": "error",

      // -- Security --
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // -- Logger enforcement --
      // stdout is reserved for MCP stdio transport. Use markscribeLog from markscribe-log.ts.
      "no-console": ["error", { allow: ["warn", "error"] }],

      // -- Disable-escape prevention --
      // Every eslint-disable must explain why
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/require-description": "error",

      // -- TypeScript strictness --
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],

      // -- Structural ordering --
      // Consistent member ordering in service classes
      "@typescript-eslint/member-ordering": [
        "error",
        {
          default: {
            memberTypes: [
              "public-static-field",
              "protected-static-field",
              "private-static-field",
              "public-instance-field",
              "protected-instance-field",
              "private-instance-field",
              "constructor",
              "public-method",
              "protected-method",
              "private-method",
            ],
          },
        },
      ],
    },
  },

  // === Architectural boundary: services must not import from tools ===
  // SPEC: "A thin tool registration layer maps MCP tool calls to service methods.
  //        Services are injected at startup, not global singletons."
  {
    files: ["src/services/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../tools/*", "../tools"],
              message:
                "Services must not import from tools/. Pass dependencies via constructor injection.",
            },
          ],
        },
      ],
    },
  },

  // === Architectural boundary: stdio-only transport ===
  // SPEC: "No HTTP, no WebSocket, no REST API dependency — pure filesystem access."
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "http",
              message:
                "This is a stdio MCP server. Use @modelcontextprotocol/sdk transport, not http.",
            },
            {
              name: "https",
              message:
                "This is a stdio MCP server. Use @modelcontextprotocol/sdk transport, not https.",
            },
            { name: "express", message: "This is a stdio MCP server. No HTTP framework needed." },
            { name: "fastify", message: "This is a stdio MCP server. No HTTP framework needed." },
            { name: "ws", message: "This is a stdio MCP server. No WebSocket needed." },
          ],
        },
      ],
    },
  },

  // === Architectural boundary: stateless runtime ===
  // SPEC: "No persistent index, no SQLite, no file watchers, no in-memory caches."
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "better-sqlite3",
              message:
                "Server is stateless at runtime. No database dependencies. Rebuild state on each call.",
            },
            {
              name: "sqlite3",
              message:
                "Server is stateless at runtime. No database dependencies. Rebuild state on each call.",
            },
            {
              name: "chokidar",
              message:
                "Server is stateless at runtime. No file watchers. Schemas reload on restart.",
            },
          ],
        },
      ],
    },
  },

  // === Test file overrides ===
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "tests/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "import-x/no-default-export": "off",
    },
  },

  // === Ignore patterns ===
  {
    ignores: ["dist/", "build/", "node_modules/", "coverage/", "docs/", "*.config.{js,mjs,cjs,ts}"],
  },

  // ARCHITECTURAL CONSTRAINTS (unencodable — enforce via code review / CLAUDE.md)
  // - Atomic writes everywhere: all write ops must use write-to-temp-then-rename
  // - Schema-driven conventions only: server never hard-codes vault-specific rules
  // - Path security defaults immutable: hardcoded blocklist entries cannot be removed by user config
);
