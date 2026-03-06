import type { Config } from "drizzle-kit";

const prefix = process.env.DB_PREFIX ?? "";
export default {
	schema: ["./src/server/db/schema.ts", "./src/server/db/pods-schema.ts"],
	dialect: "postgresql",
	dbCredentials: {
		url: process.env?.DATABASE_URL ?? "",
		ssl: process.env?.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
	},
	tablesFilter: [`${prefix}_*`],
	out: "./src/migrations",
	verbose: true,
	strict: true,
} satisfies Config;
