export function inferVideoContentType(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".mkv")) return "video/x-matroska";
  if (lowerPath.endsWith(".mpg") || lowerPath.endsWith(".mpeg")) return "video/mpeg";
  if (lowerPath.endsWith(".webm")) {
    return "video/webm";
  }
  if (lowerPath.endsWith(".m4v")) {
    return "video/x-m4v";
  }
  return "video/mp4";
}
