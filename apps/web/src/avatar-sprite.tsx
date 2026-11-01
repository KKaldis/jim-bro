import agentRaw from "./assets/agent-2.svg?raw";
import userRaw from "./assets/user-2.svg?raw";

// The Jim-Bro avatars are ~10KB single-path SVGs rendered on every chat
// message. As <img src="/foo.svg"> each one is a separate (dev-uncached) HTTP
// request and a fresh decode; inlining the full markup per message would instead
// bloat the DOM by 10KB × message count. The middle ground is an SVG sprite:
// the path data lives once as a hidden <symbol>, and each avatar is a tiny
// <use href="#…"> with no network request at all. Mount <AvatarSprite/> once,
// near the app root.

type AvatarSymbol = { id: string; viewBox: string; inner: string };

// Reduce a standalone <svg> document (incl. Inkscape/sodipodi cruft) to just its
// viewBox + path element, the only parts a <symbol> needs.
function parseSvg(raw: string, id: string): AvatarSymbol {
  const viewBox = raw.match(/viewBox="([^"]*)"/)?.[1] ?? "0 0 24 24";
  const paths = raw.match(/<path[\s\S]*?\/>/g)?.join("") ?? "";
  // Inkscape frequently nests the path under a translated <g>; the path
  // coordinates only fall inside the viewBox once that transform is applied.
  // Dropping the group misplaces the avatar, so keep its opening tag if present.
  const groupOpen = raw.match(/<g\b[^>]*\btransform="[^"]*"[^>]*>/)?.[0];
  const inner = groupOpen ? `${groupOpen}${paths}</g>` : paths;
  return { id, viewBox, inner };
}

export const AVATAR_USER_ID = "fa-avatar-user";
export const AVATAR_AGENT_ID = "fa-avatar-agent";

const SYMBOLS: AvatarSymbol[] = [
  parseSvg(userRaw, AVATAR_USER_ID),
  parseSvg(agentRaw, AVATAR_AGENT_ID),
];

export function AvatarSprite() {
  return (
    <svg aria-hidden="true" focusable="false" className="absolute size-0 overflow-hidden">
      {SYMBOLS.map((s) => (
        <symbol
          key={s.id}
          id={s.id}
          viewBox={s.viewBox}
          dangerouslySetInnerHTML={{ __html: s.inner }}
        />
      ))}
    </svg>
  );
}
