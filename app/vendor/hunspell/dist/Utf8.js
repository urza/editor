export function encodeUtf8(text) {
    const textEncoder = new TextEncoder();
    return textEncoder.encode(text);
}
export function decodeUtf8(buffer) {
    const maxChunkSize = 2 ** 24;
    const decoder = new ChunkedUtf8Decoder();
    for (let offset = 0; offset < buffer.length; offset += maxChunkSize) {
        const chunk = buffer.subarray(offset, offset + maxChunkSize);
        decoder.writeChunk(chunk);
    }
    return decoder.toString();
}
export class ChunkedUtf8Decoder {
    str = '';
    textDecoder = new TextDecoder('utf-8');
    writeChunk(chunk) {
        const decodedChunk = this.textDecoder.decode(chunk);
        this.str += decodedChunk;
    }
    toString() {
        return this.str;
    }
}
//# sourceMappingURL=Utf8.js.map