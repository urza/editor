export function concatUint8Arrays(arrays) {
    return concatTypedArrays(Uint8Array, arrays);
}
function concatTypedArrays(TypedArrayConstructor, arrays) {
    let totalLength = 0;
    for (const array of arrays) {
        totalLength += array.length;
    }
    const result = new TypedArrayConstructor(totalLength);
    let writeOffset = 0;
    for (const array of arrays) {
        result.set(array, writeOffset);
        writeOffset += array.length;
    }
    return result;
}
export function getRandomId() {
    return Math.random().toString().substring(2);
}
//# sourceMappingURL=Utilities.js.map