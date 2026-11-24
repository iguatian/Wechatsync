/**
 * sm-crypto 的最小类型声明。
 *
 * 上游仓库缺少该文件（.gitignore 里的 `packages/*\/src/**\/*.d.ts` 把它一起忽略了），
 * 而 dute.ts 通过 `/// <reference path="./sm-crypto.d.ts" />` 引用，导致 DTS 构建失败：
 *   TS6053: File 'sm-crypto.d.ts' not found
 *
 * 这里只做最小声明，方法签名保持宽松，避免与运行时用法产生类型冲突。
 */
declare module 'sm-crypto' {
  interface Sm2 {
    doEncrypt(data: string | number[], publicKey: string, cipherMode?: number): string
    doDecrypt(data: string, privateKey: string, cipherMode?: number): string
    generateKeyPairHex(): { publicKey: string; privateKey: string }
    compressPublicKeyHex(publicKey: string): string
    comparePublicKeyHex(a: string, b: string): boolean
  }

  interface Sm4 {
    // 第三个参数：站内调用传 padding（number 0），也支持 { padding: 'none' } 形式
    encrypt(data: string | number[], key: string | number[], options?: number | Record<string, unknown>): string
    decrypt(data: string | number[], key: string | number[], options?: number | Record<string, unknown>): string
  }

  interface SmCryptoLib {
    sm2: Sm2
    sm3: (data: string | number[]) => string
    sm4: Sm4
  }

  const smCrypto: SmCryptoLib
  export default smCrypto
}
