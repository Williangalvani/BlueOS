/** Little endian cursor over the primitive types used by MCAP records. */
export class RecordReader {
  private view: DataView

  constructor(private data: Uint8Array, public offset = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  get remaining(): number {
    return this.data.length - this.offset
  }

  uint8(): number {
    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  uint16(): number {
    const value = this.view.getUint16(this.offset, true)
    this.offset += 2
    return value
  }

  uint32(): number {
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  uint64(): bigint {
    const value = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return value
  }

  /** MCAP lengths are u64, but anything we index must fit in a JS number anyway. */
  size(): number {
    return Number(this.uint64())
  }

  string(): string {
    const length = this.uint32()
    const bytes = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return new TextDecoder().decode(bytes)
  }

  bytes(length: number): Uint8Array {
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  skip(length: number): void {
    this.offset += length
  }
}

/** Walks the records of a summary or chunk section, ignoring records the caller has no use for. */
export function forEachRecord(
  data: Uint8Array,
  callback: (opcode: number, reader: RecordReader, end: number) => void,
): void {
  const reader = new RecordReader(data)
  while (reader.remaining > 9) {
    const opcode = reader.uint8()
    const length = reader.size()
    const end = reader.offset + length
    callback(opcode, reader, end)
    reader.offset = end
  }
}
