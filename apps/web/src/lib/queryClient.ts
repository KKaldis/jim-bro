import { QueryClient } from "@tanstack/react-query";

// Shared React Query client. This is the server-cache that replaces the old
// `dataVersion` counter (FIXES #6): screens read through `useQuery` hooks and a
// mutation invalidates only the affected query keys, so logging a set or a meal
// no longer refetches + flashes every screen. React Query keeps the previous
// data on screen while a background refetch runs, which is what kills the flash.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is fresh for 30s — switching tabs/days within that window serves
      // from cache with no network. Mutations invalidate explicitly.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
