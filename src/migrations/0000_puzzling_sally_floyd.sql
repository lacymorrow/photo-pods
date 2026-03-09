CREATE TYPE "public"."team_type" AS ENUM('personal', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."pod_member_role" AS ENUM('owner', 'contributor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."pod_visibility" AS ENUM('public', 'private', 'invite-only');--> statement-breakpoint
CREATE TABLE "db_account" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "db_account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "db_api_key" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"key" varchar(255) NOT NULL,
	"user_id" varchar(255),
	"project_id" varchar(255),
	"name" varchar(255) NOT NULL,
	"description" text,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "db_authenticator" (
	"credentialID" text NOT NULL,
	"userId" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"credentialPublicKey" text NOT NULL,
	"counter" integer NOT NULL,
	"credentialDeviceType" text NOT NULL,
	"credentialBackedUp" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "db_authenticator_userId_credentialID_pk" PRIMARY KEY("userId","credentialID"),
	CONSTRAINT "db_authenticator_credentialID_unique" UNIQUE("credentialID")
);
--> statement-breakpoint
CREATE TABLE "db_credit_transaction" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"amount" integer NOT NULL,
	"type" varchar(50) NOT NULL,
	"description" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_name" text NOT NULL,
	"description" text,
	"github_repo_url" text,
	"github_repo_name" text,
	"vercel_project_id" text,
	"vercel_project_url" text,
	"vercel_deployment_id" text,
	"vercel_deployment_url" text,
	"status" text DEFAULT 'deploying' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_feedback" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"source" varchar(50) NOT NULL,
	"metadata" text DEFAULT '{}',
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_payment" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"order_id" varchar(255),
	"processor_order_id" varchar(255),
	"amount" integer,
	"status" varchar(255) NOT NULL,
	"processor" varchar(50),
	"product_name" text,
	"is_free_product" boolean DEFAULT false,
	"metadata" text DEFAULT '{}',
	"purchased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_permission" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"resource" varchar(255) NOT NULL,
	"action" varchar(255) NOT NULL,
	"attributes" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_plan" (
	"id" serial PRIMARY KEY NOT NULL,
	"productId" integer NOT NULL,
	"productName" text,
	"variantId" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" text NOT NULL,
	"isUsageBased" boolean DEFAULT false,
	"interval" text,
	"intervalCount" integer,
	"trialInterval" text,
	"trialIntervalCount" integer,
	"sort" integer,
	CONSTRAINT "db_plan_variantId_unique" UNIQUE("variantId")
);
--> statement-breakpoint
CREATE TABLE "db_post" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(256),
	"createdById" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_project_member" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_project" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"team_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_role_permission" (
	"role_id" varchar(255) NOT NULL,
	"permission_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "db_role_permission_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "db_role" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_session" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_team_member" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"team_id" varchar(255) NOT NULL,
	"role" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_team" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "team_type" DEFAULT 'workspace' NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_temporary_link" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255),
	"data" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"type" varchar(50) NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "db_user_credit" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "db_user_credit_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "db_user_file" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"location" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_user" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"email_verified" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"image" varchar(255),
	"password" varchar(255),
	"github_username" varchar(255),
	"role" varchar(50) DEFAULT 'user' NOT NULL,
	"bio" text,
	"theme" varchar(20) DEFAULT 'system',
	"metadata" text,
	"vercel_connection_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "db_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "db_verificationToken" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "db_verificationToken_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "db_waitlist_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"company" varchar(255),
	"role" varchar(100),
	"project_type" varchar(100),
	"timeline" varchar(100),
	"interests" text,
	"is_notified" boolean DEFAULT false,
	"notified_at" timestamp with time zone,
	"source" varchar(50) DEFAULT 'website',
	"metadata" text DEFAULT '{}',
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "db_waitlist_entry_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "db_webhook_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"processed" boolean DEFAULT false,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_pod_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" uuid NOT NULL,
	"invited_by_id" varchar(255) NOT NULL,
	"token" varchar(64) NOT NULL,
	"role" "pod_member_role" DEFAULT 'viewer' NOT NULL,
	"email" varchar(255),
	"expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "db_pod_invite_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "db_pod_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" "pod_member_role" DEFAULT 'viewer' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_pod_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" uuid NOT NULL,
	"uploaded_by_id" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"thumbnail_url" text,
	"caption" text,
	"width" integer,
	"height" integer,
	"size" integer,
	"mime_type" varchar(100),
	"exif_data" json,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_pod" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"cover_photo_url" text,
	"visibility" "pod_visibility" DEFAULT 'invite-only' NOT NULL,
	"created_by_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "db_account" ADD CONSTRAINT "db_account_userId_db_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_api_key" ADD CONSTRAINT "db_api_key_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_api_key" ADD CONSTRAINT "db_api_key_project_id_db_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."db_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_authenticator" ADD CONSTRAINT "db_authenticator_userId_db_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_credit_transaction" ADD CONSTRAINT "db_credit_transaction_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_deployments" ADD CONSTRAINT "db_deployments_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_post" ADD CONSTRAINT "db_post_createdById_db_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."db_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_project_member" ADD CONSTRAINT "db_project_member_project_id_db_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."db_project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_project_member" ADD CONSTRAINT "db_project_member_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_project" ADD CONSTRAINT "db_project_team_id_db_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."db_team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_role_permission" ADD CONSTRAINT "db_role_permission_role_id_db_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."db_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_role_permission" ADD CONSTRAINT "db_role_permission_permission_id_db_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."db_permission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_session" ADD CONSTRAINT "db_session_userId_db_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_team_member" ADD CONSTRAINT "db_team_member_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_team_member" ADD CONSTRAINT "db_team_member_team_id_db_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."db_team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_temporary_link" ADD CONSTRAINT "db_temporary_link_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_user_credit" ADD CONSTRAINT "db_user_credit_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_user_file" ADD CONSTRAINT "db_user_file_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_invite" ADD CONSTRAINT "db_pod_invite_pod_id_db_pod_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."db_pod"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_invite" ADD CONSTRAINT "db_pod_invite_invited_by_id_db_user_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_member" ADD CONSTRAINT "db_pod_member_pod_id_db_pod_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."db_pod"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_member" ADD CONSTRAINT "db_pod_member_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD CONSTRAINT "db_pod_photo_pod_id_db_pod_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."db_pod"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD CONSTRAINT "db_pod_photo_uploaded_by_id_db_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod" ADD CONSTRAINT "db_pod_created_by_id_db_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "db_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "credit_transaction_user_id_idx" ON "db_credit_transaction" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_transaction_type_idx" ON "db_credit_transaction" USING btree ("type");--> statement-breakpoint
CREATE INDEX "deployment_user_id_idx" ON "db_deployments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deployment_status_idx" ON "db_deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deployment_created_at_idx" ON "db_deployments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "createdById_idx" ON "db_post" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX "name_idx" ON "db_post" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_credit_user_id_idx" ON "db_user_credit" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_file_user_id_idx" ON "db_user_file" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "waitlist_email_idx" ON "db_waitlist_entry" USING btree ("email");--> statement-breakpoint
CREATE INDEX "waitlist_created_at_idx" ON "db_waitlist_entry" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "waitlist_is_notified_idx" ON "db_waitlist_entry" USING btree ("is_notified");--> statement-breakpoint
CREATE INDEX "pod_invite_token_idx" ON "db_pod_invite" USING btree ("token");--> statement-breakpoint
CREATE INDEX "pod_invite_pod_idx" ON "db_pod_invite" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "pod_member_pod_idx" ON "db_pod_member" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "pod_member_user_idx" ON "db_pod_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pod_photo_pod_idx" ON "db_pod_photo" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "pod_photo_uploaded_by_idx" ON "db_pod_photo" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "pod_created_by_idx" ON "db_pod" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "pod_visibility_idx" ON "db_pod" USING btree ("visibility");