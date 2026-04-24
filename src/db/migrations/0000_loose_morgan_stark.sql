CREATE TYPE "public"."bridge_status" AS ENUM('initiated', 'burned', 'attested', 'claimed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deposit_source" AS ENUM('crypto_direct', 'fiat_settlement', 'bridge');--> statement-breakpoint
CREATE TYPE "public"."fiat_payment_status" AS ENUM('initiated', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."fiat_provider" AS ENUM('moonpay', 'monnify');--> statement-breakpoint
CREATE TYPE "public"."kyc_provider" AS ENUM('smile_identity');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('none', 'pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."provider_webhook_provider" AS ENUM('alchemy', 'moonpay', 'monnify', 'flutterwave', 'smile_identity');--> statement-breakpoint
CREATE TYPE "public"."provider_webhook_status" AS ENUM('active', 'failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('initiated', 'pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_type" AS ENUM('crypto', 'naira');--> statement-breakpoint
CREATE TABLE "allowlist_emails" (
	"email" text PRIMARY KEY NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_chain_id" integer NOT NULL,
	"dest_chain_id" integer NOT NULL,
	"source_tx_hash" text,
	"dest_tx_hash" text,
	"amount_usdc" numeric(20, 6) NOT NULL,
	"status" "bridge_status" DEFAULT 'initiated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_state" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"last_confirmed_block" bigint NOT NULL,
	"reorg_depth" integer DEFAULT 12 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"amount_usdc" numeric(20, 6) NOT NULL,
	"source" "deposit_source" NOT NULL,
	"fiat_payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiat_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "fiat_provider" NOT NULL,
	"provider_tx_id" text NOT NULL,
	"amount_fiat" numeric(20, 2) NOT NULL,
	"currency_fiat" text NOT NULL,
	"amount_usdc" numeric(20, 6) NOT NULL,
	"dest_chain_id" integer NOT NULL,
	"dest_safe_address" text NOT NULL,
	"status" "fiat_payment_status" DEFAULT 'initiated' NOT NULL,
	"state_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kyc_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "kyc_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"status" "kyc_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider_webhook_provider" NOT NULL,
	"resource_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"subscription_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "provider_webhook_status" DEFAULT 'active' NOT NULL,
	"last_failed_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hmac_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_safes" (
	"user_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"safe_address" text NOT NULL,
	"deployed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"magic_eoa" text NOT NULL,
	"kyc_status" "kyc_status" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "withdrawal_type" NOT NULL,
	"tx_hash" text,
	"payout_reference" text,
	"amount_usdc" numeric(20, 6) NOT NULL,
	"recipient_address" text,
	"bank_details" jsonb,
	"status" "withdrawal_status" DEFAULT 'initiated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridges" ADD CONSTRAINT "bridges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_fiat_payment_id_fiat_payments_id_fk" FOREIGN KEY ("fiat_payment_id") REFERENCES "public"."fiat_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiat_payments" ADD CONSTRAINT "fiat_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_safes" ADD CONSTRAINT "user_safes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridges_user_idx" ON "bridges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bridges_status_idx" ON "bridges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bridges_source_tx_idx" ON "bridges" USING btree ("source_tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_chain_tx_log_uniq" ON "deposits" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "deposits_user_idx" ON "deposits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deposits_source_idx" ON "deposits" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "fiat_payments_provider_tx_uniq" ON "fiat_payments" USING btree ("provider","provider_tx_id");--> statement-breakpoint
CREATE INDEX "fiat_payments_user_idx" ON "fiat_payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fiat_payments_status_idx" ON "fiat_payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_records_provider_ref_uniq" ON "kyc_records" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "kyc_records_user_idx" ON "kyc_records" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_webhooks_provider_webhook_uniq" ON "provider_webhooks" USING btree ("provider","webhook_id");--> statement-breakpoint
CREATE INDEX "provider_webhooks_resource_idx" ON "provider_webhooks" USING btree ("provider","resource_id");--> statement-breakpoint
CREATE INDEX "provider_webhooks_status_idx" ON "provider_webhooks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_safes_user_chain_uniq" ON "user_safes" USING btree ("user_id","chain_id");--> statement-breakpoint
CREATE INDEX "user_safes_safe_address_idx" ON "user_safes" USING btree ("safe_address");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uniq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_magic_eoa_uniq" ON "users" USING btree ("magic_eoa");--> statement-breakpoint
CREATE INDEX "withdrawals_user_idx" ON "withdrawals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "withdrawals_status_idx" ON "withdrawals" USING btree ("status");