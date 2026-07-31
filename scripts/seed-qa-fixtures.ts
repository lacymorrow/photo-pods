/**
 * QA test-infra bootstrap seed (LAC-3138).
 *
 * Idempotently seeds two credential users (A + B) and a small pod graph
 * so the Playwright cross-pod ACL and functional suites (LAC-2860 §2 / §1.2
 * S1-S3) have real data to run against.
 *
 * Usage:
 *   DATABASE_URL=... PAYLOAD_SECRET=... \
 *   E2E_USER_A_PASSWORD=... E2E_USER_B_PASSWORD=... \
 *     bun run scripts/seed-qa-fixtures.ts
 *
 * Optional overrides:
 *   E2E_USER_A_EMAIL (default: qa-user-a@photo-pods.test)
 *   E2E_USER_B_EMAIL (default: qa-user-b@photo-pods.test)
 *
 * Prints a JSON manifest to stdout with the created user + pod IDs; the
 * Playwright fixture reads that manifest (via `tests/e2e/fixtures/qa.json`)
 * to know which accounts and pods to target.
 */

import { and, eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { db } from "@/server/db";
import { AuthService } from "@/server/services/auth-service";
import { podMembers, pods } from "@/server/db/pods-schema";

const USER_A_EMAIL = (process.env.E2E_USER_A_EMAIL ?? "qa-user-a@photo-pods.test").toLowerCase();
const USER_B_EMAIL = (process.env.E2E_USER_B_EMAIL ?? "qa-user-b@photo-pods.test").toLowerCase();

const USER_A_PASSWORD = process.env.E2E_USER_A_PASSWORD;
const USER_B_PASSWORD = process.env.E2E_USER_B_PASSWORD;

const MANIFEST_PATH = resolve(
	process.env.E2E_FIXTURE_MANIFEST ?? "tests/e2e/fixtures/qa.json",
);

interface SeededUser {
	id: string;
	email: string;
}

interface SeededPod {
	id: string;
	name: string;
	visibility: "private" | "group" | "public";
	ownerEmail: string;
}

interface Manifest {
	seededAt: string;
	users: {
		A: SeededUser;
		B: SeededUser;
	};
	pods: {
		privateOwnedByA: SeededPod; // A is owner, B is member. S1: A can view. S2: outside user cannot.
		publicOwnedByA: SeededPod; // A is owner. S3: any signed-in user can view + follow.
		privateOwnedByB: SeededPod; // B is owner, A is NOT a member. S1 negative: A must not view.
	};
	notes: string[];
}

async function ensureUser(email: string, password: string): Promise<SeededUser> {
	if (!db) throw new Error("DATABASE_URL is not configured");

	const existing = await db.query.users.findFirst({
		where: (u, { eq: e }) => e(u.email, email),
	});
	if (existing) {
		console.log(`user exists: ${email} (${existing.id})`);
		return { id: existing.id, email };
	}

	const result = await AuthService.createUserViaCMS({
		email,
		password,
		name: email.split("@")[0],
	});
	if (result.error || !result.user) {
		throw new Error(`Failed to create user ${email}: ${result.error ?? "unknown"}`);
	}
	console.log(`user created: ${email} (${result.user.id})`);
	return { id: String(result.user.id), email };
}

async function ensurePod(args: {
	name: string;
	visibility: "private" | "group" | "public";
	ownerId: string;
	memberIds?: string[];
}): Promise<SeededPod> {
	if (!db) throw new Error("DATABASE_URL is not configured");

	const [existing] = await db
		.select()
		.from(pods)
		.where(and(eq(pods.name, args.name), eq(pods.createdById, args.ownerId)))
		.limit(1);

	let pod = existing;
	if (!pod) {
		const [created] = await db
			.insert(pods)
			.values({
				name: args.name,
				visibility: args.visibility,
				createdById: args.ownerId,
				memberCount: 1 + (args.memberIds?.length ?? 0),
			})
			.returning();
		if (!created) throw new Error(`Failed to insert pod ${args.name}`);
		pod = created;
		console.log(`pod created: ${args.name} (${pod.id})`);
	} else {
		console.log(`pod exists: ${args.name} (${pod.id})`);
	}

	const desiredMemberships: { userId: string; role: "owner" | "member" }[] = [
		{ userId: args.ownerId, role: "owner" },
		...(args.memberIds ?? []).map((userId) => ({ userId, role: "member" as const })),
	];

	for (const m of desiredMemberships) {
		const [row] = await db
			.select()
			.from(podMembers)
			.where(and(eq(podMembers.podId, pod.id), eq(podMembers.userId, m.userId)))
			.limit(1);
		if (row) continue;
		await db
			.insert(podMembers)
			.values({ podId: pod.id, userId: m.userId, role: m.role });
	}

	return {
		id: pod.id,
		name: pod.name,
		visibility: args.visibility,
		ownerEmail: "",
	};
}

async function main() {
	if (!USER_A_PASSWORD || !USER_B_PASSWORD) {
		console.error(
			"E2E_USER_A_PASSWORD and E2E_USER_B_PASSWORD are required. Refusing to seed with a default password.",
		);
		process.exit(1);
	}
	if (!db) {
		console.error("DATABASE_URL is not configured. Cannot seed.");
		process.exit(1);
	}

	console.log("seeding QA fixtures...");

	const userA = await ensureUser(USER_A_EMAIL, USER_A_PASSWORD);
	const userB = await ensureUser(USER_B_EMAIL, USER_B_PASSWORD);

	const privateOwnedByA = await ensurePod({
		name: "QA-private-A",
		visibility: "private",
		ownerId: userA.id,
		memberIds: [userB.id],
	});
	const publicOwnedByA = await ensurePod({
		name: "QA-public-A",
		visibility: "public",
		ownerId: userA.id,
	});
	const privateOwnedByB = await ensurePod({
		name: "QA-private-B",
		visibility: "private",
		ownerId: userB.id,
	});

	const manifest: Manifest = {
		seededAt: new Date().toISOString(),
		users: { A: userA, B: userB },
		pods: {
			privateOwnedByA: { ...privateOwnedByA, ownerEmail: userA.email },
			publicOwnedByA: { ...publicOwnedByA, ownerEmail: userA.email },
			privateOwnedByB: { ...privateOwnedByB, ownerEmail: userB.email },
		},
		notes: [
			"Passwords are not stored in the manifest. Playwright reads them from env at test time.",
			"Re-running is idempotent: existing users/pods/memberships are reused.",
		],
	};

	mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`\nmanifest written: ${MANIFEST_PATH}`);
	console.log(JSON.stringify(manifest, null, 2));
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("seed failed:", err);
		process.exit(1);
	});
