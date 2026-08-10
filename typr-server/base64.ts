/** Linear-time validation for padded or unpadded standard base64. */
export function isBase64(value: string): boolean {
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  const remainder = contentLength % 4;
  if (remainder === 1 || (padding > 0 && value.length % 4 !== 0) ||
      (padding === 1 && remainder !== 3) || (padding === 2 && remainder !== 2)) {
    return false;
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 || code === 47
    )) return false;
  }
  return true;
}
