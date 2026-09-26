export class Arc4 {
  private readonly state = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Uint8Array) {
    for (let index = 0; index < 256; index++) {
      this.state[index] = index;
    }
    let j = 0;
    for (let index = 0; index < 256; index++) {
      j = (j + this.state[index]! + key[index % key.length]!) & 255;
      const swap = this.state[index]!;
      this.state[index] = this.state[j]!;
      this.state[j] = swap;
    }
  }

  process(data: Uint8Array): void {
    for (let offset = 0; offset < data.length; offset++) {
      this.i = (this.i + 1) & 255;
      this.j = (this.j + this.state[this.i]!) & 255;
      const swap = this.state[this.i]!;
      this.state[this.i] = this.state[this.j]!;
      this.state[this.j] = swap;
      data[offset] = data[offset]! ^ this.state[(this.state[this.i]! + this.state[this.j]!) & 255]!;
    }
  }
}
