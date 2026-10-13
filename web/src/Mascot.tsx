// Hathi, the foreman: a matte-black elephant who runs the chit. Elephants keep the books and never forget a draw.
// Pure SVG with CSS animation; the phase picks what the trunk is holding and what it is doing.
export type Mood = "idle" | "collect" | "auction" | "payout" | "done";

export function Mascot({ mood, children }: { mood: Mood; children?: React.ReactNode }) {
  return (
    <svg className={`mascot mascot-${mood}`} viewBox="0 0 320 340" role="img" aria-label={{ idle: "Hathi the foreman, waiting", collect: "Hathi collecting instalments", auction: "Hathi raising the gavel", payout: "Hathi handing over the prize", done: "Hathi holding the minutes" }[mood]}>
      <ellipse className="shadow" cx="160" cy="326" rx="110" ry="10" />
      {/* ears */}
      <g className="ear ear-l"><ellipse cx="72" cy="150" rx="50" ry="62" /><ellipse className="ear-in" cx="78" cy="152" rx="30" ry="42" /></g>
      <g className="ear ear-r"><ellipse cx="248" cy="150" rx="50" ry="62" /><ellipse className="ear-in" cx="242" cy="152" rx="30" ry="42" /></g>
      {/* body and legs */}
      <ellipse className="ink" cx="160" cy="250" rx="98" ry="76" />
      <rect className="ink leg leg-l" x="96" y="276" width="44" height="54" rx="18" />
      <rect className="ink leg leg-r" x="180" y="276" width="44" height="54" rx="18" />
      <circle className="toe" cx="108" cy="322" r="4" /><circle className="toe" cx="124" cy="324" r="4" /><circle className="toe" cx="192" cy="324" r="4" /><circle className="toe" cx="208" cy="322" r="4" />
      {/* head */}
      <circle className="ink" cx="160" cy="150" r="82" />
      <circle className="sheen" cx="122" cy="100" r="14" />
      <g className="eye"><circle cx="130" cy="142" r="15" className="white" /><circle className="pupil" cx="133" cy="144" r="7.5" /><circle className="glint" cx="136" cy="139" r="2.5" /><rect className="lid" x="113" y="125" width="34" height="34" rx="17" /></g>
      <g className="eye"><circle cx="190" cy="142" r="15" className="white" /><circle className="pupil" cx="193" cy="144" r="7.5" /><circle className="glint" cx="196" cy="139" r="2.5" /><rect className="lid" x="173" y="125" width="34" height="34" rx="17" /></g>
      <circle className="cheek" cx="108" cy="176" r="7" /><circle className="cheek" cx="212" cy="176" r="7" />
      <path className="tusk" d="M130 196 q -10 16 -22 24" /><path className="tusk" d="M190 196 q 10 16 22 24" />
      {/* trunk, with whatever it is holding */}
      <g className="trunk">
        <path className="trunk-rim" d="M160 180 c 4 40 -6 60 2 86 c 4 12 14 18 24 16" /><path className="trunk-path" d="M160 180 c 4 40 -6 60 2 86 c 4 12 14 18 24 16" /><path className="trunk-line" d="M150 230 q 10 4 20 0 M152 258 q 10 4 20 0" />
        <g className="prop gavel" transform="translate(190 282)">
          <rect x="-4" y="-78" width="8" height="78" rx="4" className="handle" />
          <rect x="-30" y="-100" width="60" height="30" rx="8" className="head" />
          <rect x="-30" y="-100" width="12" height="30" rx="6" className="head-dark" />
        </g>
        <g className="prop coins" transform="translate(190 282)">
          <ellipse cx="0" cy="-10" rx="30" ry="11" className="coin" /><ellipse cx="0" cy="-22" rx="30" ry="11" className="coin" /><ellipse cx="0" cy="-34" rx="30" ry="11" className="coin" />
          <text x="0" y="-30" className="rupee">₹</text>
        </g>
        <g className="prop scroll" transform="translate(190 282)">
          <rect x="-26" y="-74" width="52" height="68" rx="4" className="paper" />
          <rect x="-16" y="-62" width="32" height="4" rx="2" className="ink" /><rect x="-16" y="-52" width="24" height="4" rx="2" className="ink" /><rect x="-16" y="-42" width="30" height="4" rx="2" className="ink" /><rect x="-16" y="-32" width="18" height="4" rx="2" className="ink" />
          <rect x="-16" y="-20" width="32" height="6" rx="3" className="stamp" />
        </g>
        <g className="prop coin-one" transform="translate(190 282)">
          <circle cx="0" cy="-22" r="18" className="coin" /><text x="0" y="-16" className="rupee rupee-small">₹</text>
        </g>
      </g>
      {children}
      <g className="sparks" aria-hidden="true">
        <path className="spark" d="M250 150 l 4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z" />
        <path className="spark" d="M282 196 l 3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" />
        <path className="spark" d="M236 110 l 3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" />
      </g>
    </svg>
  );
}

// The black flower from the brief, used as decoration and as the burst when a prize goes out.
export function Flower({ className = "", petals = 6, size = 80 }: { className?: string; petals?: number; size?: number }) {
  const r = size / 2;
  return (
    <svg className={`flower ${className}`} viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
      {Array.from({ length: petals }, (_, i) => {
        const a = (i / petals) * 2 * Math.PI;
        return <circle key={i} cx={r + Math.cos(a) * r * 0.5} cy={r + Math.sin(a) * r * 0.5} r={r * 0.42} />;
      })}
      <circle cx={r} cy={r} r={r * 0.36} />
    </svg>
  );
}
