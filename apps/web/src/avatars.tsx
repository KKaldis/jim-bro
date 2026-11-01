import { AVATAR_AGENT_ID, AVATAR_USER_ID } from "./avatar-sprite";
import { cn } from "./lib/utils";

function avatarClasses() {
  return cn(
    "inline-flex items-center justify-center overflow-hidden rounded-full bg-muted p-1 leading-none",
  );
}

export function BroAvatar({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <span className={cn(avatarClasses(), className)} style={{ width: size, height: size }}>
      <svg role="img" aria-label="Braaat" className="size-full invert dark:invert-0">
        <use href={`#${AVATAR_AGENT_ID}`} />
      </svg>
    </span>
  );
}

export function UserAvatar({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <span className={cn(avatarClasses(), className)} style={{ width: size, height: size }}>
      <svg role="img" aria-label="You" className="size-full invert dark:invert-0">
        <use href={`#${AVATAR_USER_ID}`} />
      </svg>
    </span>
  );
}
