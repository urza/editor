import { decodeUtf8, encodeUtf8 } from './Utf8.js';
export class WasmMemoryManager {
    wasmModule;
    wasmAlloc;
    wasmFree;
    allocatedReferences = new Set();
    constructor(wasmModule, options) {
        options = options ?? {};
        this.wasmModule = wasmModule;
        if (options.wasmAlloc) {
            this.wasmAlloc = options.wasmAlloc;
        }
        else {
            if (!wasmModule._malloc) {
                throw new Error(`Couldn't find a '_malloc' function in the module and no custom 'wasmAlloc' was provided in the options`);
            }
            this.wasmAlloc = wasmModule._malloc;
        }
        if (options.wasmFree) {
            this.wasmFree = options.wasmFree;
        }
        else {
            if (!wasmModule._free) {
                throw new Error(`Couldn't find a '_malloc' function in the module and no custom 'wasmFree' was provided in the options`);
            }
            this.wasmFree = wasmModule._free;
        }
    }
    allocInt8() {
        const address = this.alloc(1);
        return this.wrapInt8(address).clear();
    }
    wrapInt8(address) {
        const ref = new Int8Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocUint8() {
        const address = this.alloc(1);
        return this.wrapUint8(address).clear();
    }
    wrapUint8(address) {
        const ref = new Uint8Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocInt16() {
        const address = this.alloc(2);
        return this.wrapInt16(address).clear();
    }
    wrapInt16(address) {
        const ref = new Int16Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocUint16() {
        const address = this.alloc(2);
        return this.wrapUint16(address).clear();
    }
    wrapUint16(address) {
        const ref = new Uint16Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocInt32() {
        const address = this.alloc(4);
        return this.wrapInt32(address).clear();
    }
    wrapInt32(address) {
        const ref = new Int32Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocUint32() {
        const address = this.alloc(4);
        return this.wrapUint32(address).clear();
    }
    wrapUint32(address) {
        const ref = new Uint32Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocPointer() {
        const address = this.alloc(4);
        return this.wrapPointer(address).clear();
    }
    wrapPointer(address) {
        const ref = new PointerRef(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocFloat32() {
        const address = this.alloc(4);
        return this.wrapFloat64(address).clear();
    }
    wrapFloat32(address) {
        const ref = new Float32Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocFloat64() {
        const address = this.alloc(8);
        return this.wrapFloat64(address).clear();
    }
    wrapFloat64(address) {
        const ref = new Float64Ref(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    // Allocate or wrap arrays
    allocInt8Array(length) {
        const address = this.alloc(length << 0);
        return this.wrapInt8Array(address, length).clear();
    }
    wrapInt8Array(address, length) {
        const ref = new Int8ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocUint8Array(length) {
        const address = this.alloc(length << 0);
        return this.wrapUint8Array(address, length).clear();
    }
    wrapUint8Array(address, length) {
        const ref = new Uint8ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocInt16Array(length) {
        const address = this.alloc(length << 1);
        return this.wrapInt16Array(address, length).clear();
    }
    wrapInt16Array(address, length) {
        const ref = new Int16ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocUint16Array(length) {
        const address = this.alloc(length << 1);
        return this.wrapUint16Array(address, length).clear();
    }
    wrapUint16Array(address, length) {
        const ref = new Uint16ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocInt32Array(length) {
        const address = this.alloc(length << 2);
        return this.wrapInt32Array(address, length).clear();
    }
    wrapInt32Array(address, length) {
        const ref = new Int32ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocUint32Array(length) {
        const address = this.alloc(length << 2);
        return this.wrapUint32Array(address, length).clear();
    }
    wrapUint32Array(address, length) {
        const ref = new Uint32ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocFloat32Array(length) {
        const address = this.alloc(length << 2);
        return this.wrapFloat32Array(address, length).clear();
    }
    wrapFloat32Array(address, length) {
        const ref = new Float32ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocFloat64Array(length) {
        const address = this.alloc(length << 3);
        return this.wrapFloat64Array(address, length).clear();
    }
    wrapFloat64Array(address, length) {
        const ref = new Float64ArrayRef(address, length, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    allocNullTerminatedUtf8String(str) {
        const strBuffer = encodeUtf8(str);
        const ref = this.allocUint8Array(strBuffer.length + 1);
        ref.view.set(strBuffer);
        return ref;
    }
    wrapNullTerminatedUtf8String(address) {
        const ref = new NullTerminatedUtf8StringRef(address, this);
        this.allocatedReferences.add(ref);
        return ref;
    }
    alloc(size) {
        const ptr = this.wasmAlloc(size);
        return ptr;
    }
    free(wasmReference) {
        if (wasmReference.isFreed) {
            return;
        }
        this.wasmFree(wasmReference.address);
        this.allocatedReferences.delete(wasmReference);
        wasmReference.clearAddress();
    }
    freeAll() {
        for (const wasmReference of this.allocatedReferences) {
            this.free(wasmReference);
        }
    }
    detach(wasmReference) {
        this.allocatedReferences.delete(wasmReference);
        return wasmReference;
    }
}
class ValueRef {
    ptr;
    manager;
    get module() { return this.manager.wasmModule; }
    constructor(ptr, manager) {
        this.ptr = ptr;
        this.manager = manager;
    }
    get value() {
        this.assertNotFreed();
        return this.getValue();
    }
    set value(newValue) {
        this.assertNotFreed();
        this.setValue(newValue);
    }
    get address() {
        this.assertNotFreed();
        return this.ptr;
    }
    clear() {
        this.assertNotFreed();
        if (typeof this.value == 'number') {
            this.value = 0;
        }
        else if (typeof this.value == 'string') {
            throw new Error('Unimplemented');
        }
        return this;
    }
    free() {
        this.manager.free(this);
    }
    detach() {
        return this.manager.detach(this);
    }
    clearAddress() {
        this.ptr = 0;
    }
    get isFreed() { return this.ptr == 0; }
    assertNotFreed() {
        if (this.isFreed) {
            throw new Error('Attempt to read a freed WASM value reference.');
        }
    }
}
export class Int8Ref extends ValueRef {
    getValue() {
        return this.module.HEAP8[this.ptr >>> 0];
    }
    setValue(newValue) {
        this.module.HEAP8[this.ptr >>> 0] = newValue;
    }
}
export class Uint8Ref extends ValueRef {
    getValue() {
        return this.module.HEAPU8[this.ptr >>> 0];
    }
    setValue(newValue) {
        this.module.HEAPU8[this.ptr >>> 0] = newValue;
    }
}
export class Int16Ref extends ValueRef {
    getValue() {
        return this.module.HEAP16[this.ptr >>> 1];
    }
    setValue(newValue) {
        this.module.HEAP16[this.ptr >>> 1] = newValue;
    }
}
export class Uint16Ref extends ValueRef {
    getValue() {
        return this.module.HEAPU16[this.ptr >>> 1];
    }
    setValue(newValue) {
        this.module.HEAPU16[this.ptr >>> 1] = newValue;
    }
}
export class Int32Ref extends ValueRef {
    getValue() {
        return this.module.HEAP32[this.ptr >>> 2];
    }
    setValue(newValue) {
        this.module.HEAP32[this.ptr >>> 2] = newValue;
    }
}
export class Uint32Ref extends ValueRef {
    getValue() {
        return this.module.HEAPU32[this.ptr >>> 2];
    }
    setValue(newValue) {
        this.module.HEAPU32[this.ptr >>> 2] = newValue;
    }
}
export class PointerRef extends Uint32Ref {
}
export class Float32Ref extends ValueRef {
    getValue() {
        return this.module.HEAPF32[this.ptr >>> 2];
    }
    setValue(newValue) {
        this.module.HEAPF32[this.ptr >>> 2] = newValue;
    }
}
export class Float64Ref extends ValueRef {
    getValue() {
        return this.module.HEAPF64[this.ptr >>> 3];
    }
    setValue(newValue) {
        this.module.HEAPF64[this.ptr >>> 3] = newValue;
    }
}
export class NullTerminatedUtf8StringRef extends ValueRef {
    getValue() {
        const ptr = this.ptr >>> 0;
        const heapU8 = this.module.HEAPU8;
        const endByteOffset = heapU8.subarray(ptr).indexOf(0);
        const strBytes = heapU8.subarray(ptr, ptr + endByteOffset);
        const str = decodeUtf8(strBytes);
        return str;
    }
    setValue(newValue) {
        throw new Error('Unimplemented');
    }
}
class TypedArrayRef {
    ptr;
    length;
    manager;
    get module() { return this.manager.wasmModule; }
    constructor(ptr, length, manager) {
        this.ptr = ptr;
        this.length = length;
        this.manager = manager;
    }
    get view() {
        this.assertNotFreed();
        return this.getView();
    }
    slice(start, end) {
        return this.view.slice(start, end);
    }
    get address() {
        this.assertNotFreed();
        return this.ptr;
    }
    clear() {
        this.view.fill(0);
        return this;
    }
    free() {
        this.manager.free(this);
    }
    clearAddress() {
        this.ptr = 0;
    }
    detach() {
        return this.manager.detach(this);
    }
    get isFreed() { return this.ptr == 0; }
    assertNotFreed() {
        if (this.isFreed) {
            throw new Error('Attempt to read a freed WASM typed array reference.');
        }
    }
}
export class Int8ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 0;
        return this.module.HEAP8.subarray(startIndex, startIndex + this.length);
    }
}
export class Uint8ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 0;
        return this.module.HEAPU8.subarray(startIndex, startIndex + this.length);
    }
    readAsNullTerminatedUtf8String() {
        let strBytes = this.view;
        const indexOfFirstZero = strBytes.indexOf(0);
        if (indexOfFirstZero >= 0) {
            strBytes = strBytes.subarray(0, indexOfFirstZero);
        }
        const str = decodeUtf8(strBytes);
        return str;
    }
}
export class Int16ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 1;
        return this.module.HEAP16.subarray(startIndex, startIndex + this.length);
    }
}
export class Uint16ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 1;
        return this.module.HEAPU16.subarray(startIndex, startIndex + this.length);
    }
}
export class Int32ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 2;
        return this.module.HEAP32.subarray(startIndex, startIndex + this.length);
    }
}
export class Uint32ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 2;
        return this.module.HEAPU32.subarray(startIndex, startIndex + this.length);
    }
}
export class Float32ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 2;
        return this.module.HEAPF32.subarray(startIndex, startIndex + this.length);
    }
}
export class Float64ArrayRef extends TypedArrayRef {
    getView() {
        const startIndex = this.ptr >>> 3;
        return this.module.HEAPF64.subarray(startIndex, startIndex + this.length);
    }
}
//# sourceMappingURL=WasmMemoryManager.js.map