export class ApiClient {
  get(path: string) {
    return fetch(path);
  }
}

export type Currency = 'USD' | 'EUR';
