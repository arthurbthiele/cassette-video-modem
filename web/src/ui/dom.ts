export function el(tag: string, props: Record<string, any> = {}, kids: (Node | string)[] = []): HTMLElement {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}
