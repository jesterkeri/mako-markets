// ----------------------------------------------------------------------------
// server-only-stub.ts
//
// Vitest alias target for the `server-only` package. Real Next.js builds
// import the published `server-only` module which throws at build time if
// it ends up in a client bundle. Vitest only needs runtime semantics —
// modules import the package for its side-effect-free type-only purpose,
// so the stub can be empty.
// ----------------------------------------------------------------------------

export {};
