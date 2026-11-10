// multicast-dns has no bundled types; discovery.ts describes the part it uses (its `Mdns` interface).
declare module 'multicast-dns' {
  const makeMdns: (opts?: Record<string, unknown>) => unknown
  export default makeMdns
}
