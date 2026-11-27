CREATE TABLE "user_settings" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"morning_time" text DEFAULT '07:30' NOT NULL,
	"evening_time" text DEFAULT '20:30' NOT NULL,
	"timezone" text DEFAULT 'Europe/Istanbul' NOT NULL,
	"chat_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
