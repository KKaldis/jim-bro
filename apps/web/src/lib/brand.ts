// App branding: the product name and the assistant persona's name (matches the
// system prompt in packages/agent/src/prompts.ts).

export type Brand = {
  name: string;
  // The in-chat name of the assistant persona.
  agentName: string;
};

export const brand: Brand = {
  name: "Jim-Bro.ai",
  agentName: "Jim Rat",
};
