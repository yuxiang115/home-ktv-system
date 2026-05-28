declare module "@meting/core" {
  export default class Meting {
    constructor(server: string);
    site(server: string): this;
    cookie(cookie: string): this;
    format(enabled: boolean): this;
    search(keyword: string, options?: { type?: number; page?: number; limit?: number }): Promise<string>;
    pic(id: string | number, size?: number): Promise<string>;
  }
}
