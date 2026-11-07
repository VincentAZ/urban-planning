// Prepacked vector atlas: front of each car points up. Keep colors and details
// in the texture so windows, tires and lamps retain their own colors.
const paint = ["#f6f2dd", "#3e6763", "#d4885b", "#647481", "#e1b859", "#faf9f2"];
export const carIconMapping = Object.fromEntries(
  paint.map((_, index) => [String(index), {
    x: index * 48, y: 0, width: 48, height: 96, mask: false,
  }]),
);
export const carIconAtlas = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="96" viewBox="0 0 288 96">
    ${paint.map((color, index) => `<g transform="translate(${index * 48} 0)">
      <rect x="6" y="19" width="8" height="17" rx="3" fill="#162027"/>
      <rect x="34" y="19" width="8" height="17" rx="3" fill="#162027"/>
      <rect x="6" y="62" width="8" height="17" rx="3" fill="#162027"/>
      <rect x="34" y="62" width="8" height="17" rx="3" fill="#162027"/>
      <path d="M17 5Q24 2 31 5Q38 8 38 21V78Q37 90 31 91H17Q11 90 10 78V21Q10 8 17 5Z" fill="${color}" stroke="#25343b" stroke-width="2"/>
      <path d="M15 31Q24 26 33 31L31 43H17Z" fill="#213c4b" stroke="#b8d9de" stroke-width="1.5"/>
      <path d="M17 64H31L33 74Q24 78 15 74Z" fill="#213c4b" stroke="#b8d9de" stroke-width="1.5"/>
      <path d="M13 38L15 45V62L13 68ZM35 38L33 45V62L35 68Z" fill="#213c4b"/>
      <rect x="17" y="45" width="14" height="17" rx="3" fill="${color}" stroke="#ffffff" stroke-opacity=".35"/>
      <path d="M15 13L14 23M33 13L34 23" stroke="#fff4c2" stroke-width="4" stroke-linecap="round"/>
      <path d="M14 82V86M34 82V86" stroke="#d94b43" stroke-width="4" stroke-linecap="round"/>
      <path d="M17 18H31M17 84H31" stroke="#25343b" stroke-opacity=".3"/>
      <path d="M8 39H12M36 39H40" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
    </g>`).join("")}
  </svg>`,
)}`;
