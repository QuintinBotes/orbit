import { escapeHtml } from './html.ts';

/** The page shell shared by every view. */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
