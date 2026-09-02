const DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function yearToCn(year: number): string {
  return String(year)
    .split('')
    .map((d) => DIGITS[Number(d)])
    .join('');
}

function numToCn(n: number): string {
  if (n <= 10) return DIGITS[n];
  if (n < 20) return '十' + (n % 10 ? DIGITS[n % 10] : '');
  return DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? DIGITS[n % 10] : '');
}

/** 2026-09-02 → 二〇二六年九月二日 */
export function cnDate(date: Date): string {
  return `${yearToCn(date.getFullYear())}年${numToCn(date.getMonth() + 1)}月${numToCn(date.getDate())}日`;
}

/** 2026 → 二〇二六 */
export function cnYear(date: Date): string {
  return yearToCn(date.getFullYear());
}
