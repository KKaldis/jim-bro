// Every app API route, in dispatch order. Infra routes (auth, health, files,
// the OpenAPI doc) are declared next to the server in ../index.ts.
import type { Route } from "../router.ts";
import { accountRoutes } from "./account.ts";
import { chatRoutes } from "./chat.ts";
import { dietRoutes } from "./diet.ts";
import { foodRoutes } from "./food.ts";
import { progressRoutes } from "./progress.ts";
import { workoutRoutes } from "./workout.ts";

export const apiRoutes: Route[] = [
  ...chatRoutes,
  ...foodRoutes,
  ...progressRoutes,
  ...accountRoutes,
  ...dietRoutes,
  ...workoutRoutes,
];
