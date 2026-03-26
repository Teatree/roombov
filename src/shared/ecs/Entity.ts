let nextId = 0;

export function generateId(): string {
  return `e${nextId++}`;
}

export function resetIdCounter(): void {
  nextId = 0;
}
