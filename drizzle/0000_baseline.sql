CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"source" varchar(32) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(128) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint,
	"chat_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "body_comp_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"weight_kg" double precision,
	"body_fat_pct" double precision,
	"body_fat_method" varchar(32),
	"waist_cm" double precision,
	"neck_cm" double precision,
	"hip_cm" double precision,
	"notes" text,
	"time" varchar(5),
	"body_fat_pct_navy" double precision,
	"bmi" double precision,
	"ffmi" double precision,
	"ffmi_normalized" double precision,
	"fat_free_mass_kg" double precision,
	"fat_mass_kg" double precision,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "body_comp_entry_body_fat_method_check" CHECK ("body_comp_entry"."body_fat_method" IN ('dexa', 'bia_scale', 'caliper', 'visual_estimate', 'navy', 'other'))
);
--> statement-breakpoint
CREATE TABLE "body_measurement" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"shoulders_cm" double precision,
	"chest_cm" double precision,
	"arm_cm" double precision,
	"forearm_cm" double precision,
	"thigh_cm" double precision,
	"calf_cm" double precision,
	"notes" text,
	"time" varchar(5),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cardio_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"resting_heart_rate" double precision,
	"max_heart_rate" double precision,
	"notes" text,
	"vo2_max" double precision,
	"vo2_max_category" varchar(16),
	"max_heart_rate_estimated" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cardio_entry_vo2_max_category_check" CHECK ("cardio_entry"."vo2_max_category" IN ('poor', 'fair', 'good', 'excellent', 'superior'))
);
--> statement-breakpoint
CREATE TABLE "conversation_message" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" jsonb NOT NULL,
	"provider" varchar(32),
	"model" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_steps" (
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"steps" integer DEFAULT 0 NOT NULL,
	"goal" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_steps_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "diet_plan" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT 'My diet plan' NOT NULL,
	"start_date" varchar(10),
	"default_target_kcal" double precision,
	"default_target_p" double precision,
	"default_target_f" double precision,
	"default_target_c" double precision,
	"default_target_fiber" double precision,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diet_plan_day" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" bigint NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"weekdays" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"target_kcal" double precision,
	"target_p" double precision,
	"target_f" double precision,
	"target_c" double precision,
	"target_fiber" double precision
);
--> statement-breakpoint
CREATE TABLE "diet_plan_meal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day_id" bigint NOT NULL,
	"slot" varchar(32) NOT NULL,
	"time" varchar(5),
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diet_plan_portion" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"meal_id" bigint NOT NULL,
	"food" text NOT NULL,
	"grams" double precision NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"kcal" double precision,
	"protein_g" double precision,
	"fat_g" double precision,
	"carbs_g" double precision,
	"fiber_g" double precision,
	"source" varchar(16)
);
--> statement-breakpoint
CREATE TABLE "meal_log" (
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"meals" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meal_log_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "pantry_item" (
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"unit" varchar(16) DEFAULT 'g' NOT NULL,
	"grams_per_serving" double precision,
	"kcal" double precision,
	"protein_g" double precision,
	"fat_g" double precision,
	"carbs_g" double precision,
	"fiber_g" double precision,
	"category" text,
	"barcode" text,
	"to_buy" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pantry_item_user_id_name_pk" PRIMARY KEY("user_id","name"),
	CONSTRAINT "pantry_item_unit_check" CHECK ("pantry_item"."unit" IN ('g', 'ml', 'pcs'))
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"sex" varchar(16) NOT NULL,
	"birth_year" integer NOT NULL,
	"height_cm" double precision NOT NULL,
	"activity_level" varchar(32) NOT NULL,
	"goal" varchar(32) NOT NULL,
	"target_weight_kg" double precision,
	"restrictions" jsonb,
	"notes" text,
	"wrist_cm" double precision,
	"ankle_cm" double precision,
	"units" varchar(16),
	"language" varchar(8) DEFAULT 'en',
	"water_goal_ml" integer,
	"gym_machine_ids" jsonb,
	"active_diet_plan_id" bigint,
	"active_workout_plan_id" bigint,
	"target_kcal" double precision,
	"target_protein_g" double precision,
	"target_fat_g" double precision,
	"target_carbs_g" double precision,
	"target_fiber_g" double precision,
	"targets_computed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "profile_sex_check" CHECK ("profile"."sex" IN ('male', 'female')),
	CONSTRAINT "profile_activity_level_check" CHECK ("profile"."activity_level" IN ('sedentary', 'light', 'moderate', 'very', 'extreme')),
	CONSTRAINT "profile_goal_check" CHECK ("profile"."goal" IN ('cut', 'maintain', 'recomp', 'lean_bulk'))
);
--> statement-breakpoint
CREATE TABLE "recipe" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"servings" double precision DEFAULT 1 NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"notes" text,
	"instructions" text,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_portion" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipe_id" bigint NOT NULL,
	"food" text NOT NULL,
	"grams" double precision NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"kcal" double precision,
	"protein_g" double precision,
	"fat_g" double precision,
	"carbs_g" double precision,
	"fiber_g" double precision,
	"source" varchar(16)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tool_feature_request" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tool_feature_request_status_check" CHECK ("tool_feature_request"."status" IN ('open', 'planned', 'declined', 'shipped'))
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" uuid,
	"iteration_index" integer,
	"message_id" bigint,
	"provider" varchar(32) DEFAULT 'anthropic' NOT NULL,
	"model" varchar(128) DEFAULT '' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"stop_reason" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "water_log" (
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"ml" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "water_log_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "workout_plan" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_plan_day" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" bigint NOT NULL,
	"weekdays" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"focus" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_plan_exercise" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_day_id" bigint NOT NULL,
	"exercise_id" text NOT NULL,
	"machine_id" text,
	"order" integer DEFAULT 0 NOT NULL,
	"target_sets" integer DEFAULT 3 NOT NULL,
	"target_reps" integer DEFAULT 8,
	"target_weight_kg" double precision,
	"target_duration_sec" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "workout_session" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" varchar(10) NOT NULL,
	"plan_day_id" bigint,
	"name" text,
	"duration_min" double precision,
	"kcal_burned" double precision,
	"notes" text,
	"started_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_session_set" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" bigint NOT NULL,
	"exercise_id" text NOT NULL,
	"machine_id" text,
	"set_index" integer NOT NULL,
	"reps" integer NOT NULL,
	"weight_kg" double precision DEFAULT 0 NOT NULL,
	"rpe" double precision,
	"duration_sec" integer,
	"distance_m" double precision,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_event" ADD CONSTRAINT "ai_usage_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_comp_entry" ADD CONSTRAINT "body_comp_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "body_measurement" ADD CONSTRAINT "body_measurement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cardio_entry" ADD CONSTRAINT "cardio_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_steps" ADD CONSTRAINT "daily_steps_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_plan" ADD CONSTRAINT "diet_plan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_plan_day" ADD CONSTRAINT "diet_plan_day_plan_id_diet_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."diet_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_plan_meal" ADD CONSTRAINT "diet_plan_meal_day_id_diet_plan_day_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."diet_plan_day"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_plan_portion" ADD CONSTRAINT "diet_plan_portion_meal_id_diet_plan_meal_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."diet_plan_meal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_log" ADD CONSTRAINT "meal_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_item" ADD CONSTRAINT "pantry_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_active_diet_plan_id_diet_plan_id_fk" FOREIGN KEY ("active_diet_plan_id") REFERENCES "public"."diet_plan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_active_workout_plan_id_workout_plan_id_fk" FOREIGN KEY ("active_workout_plan_id") REFERENCES "public"."workout_plan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_portion" ADD CONSTRAINT "recipe_portion_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_feature_request" ADD CONSTRAINT "tool_feature_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_message_id_conversation_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_log" ADD CONSTRAINT "water_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_plan" ADD CONSTRAINT "workout_plan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_plan_day" ADD CONSTRAINT "workout_plan_day_plan_id_workout_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."workout_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_plan_exercise" ADD CONSTRAINT "workout_plan_exercise_plan_day_id_workout_plan_day_id_fk" FOREIGN KEY ("plan_day_id") REFERENCES "public"."workout_plan_day"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_plan_day_id_workout_plan_day_id_fk" FOREIGN KEY ("plan_day_id") REFERENCES "public"."workout_plan_day"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session_set" ADD CONSTRAINT "workout_session_set_session_id_workout_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_event_user_idx" ON "ai_usage_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "body_comp_user_date_idx" ON "body_comp_entry" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "body_measurement_user_date_idx" ON "body_measurement" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "cardio_entry_user_date_idx" ON "cardio_entry" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "conversation_user_id_idx" ON "conversation_message" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "diet_plan_user_idx" ON "diet_plan" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "diet_plan_day_plan_idx" ON "diet_plan_day" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "diet_plan_meal_day_idx" ON "diet_plan_meal" USING btree ("day_id","position");--> statement-breakpoint
CREATE INDEX "diet_plan_portion_meal_idx" ON "diet_plan_portion" USING btree ("meal_id","position");--> statement-breakpoint
CREATE INDEX "pantry_item_barcode_idx" ON "pantry_item" USING btree ("user_id","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_user_slug_idx" ON "recipe" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX "recipe_portion_recipe_idx" ON "recipe_portion" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "tool_feature_request_user_idx" ON "tool_feature_request" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_user_idx" ON "usage_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_provider_model_idx" ON "usage_ledger" USING btree ("provider","model","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_chat_idx" ON "usage_ledger" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "workout_plan_user_idx" ON "workout_plan" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workout_plan_day_plan_idx" ON "workout_plan_day" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "workout_plan_exercise_day_idx" ON "workout_plan_exercise" USING btree ("plan_day_id","order");--> statement-breakpoint
CREATE INDEX "workout_session_user_date_idx" ON "workout_session" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "workout_set_session_idx" ON "workout_session_set" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "workout_set_exercise_idx" ON "workout_session_set" USING btree ("exercise_id","completed_at");