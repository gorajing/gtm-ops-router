import { describe, it, expect } from "vitest";
import { isPublicUnicastIp } from "../src/enrich/safe-fetch.js";

describe("isPublicUnicastIp", () => {
  const publicV4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34"];
  const blockedV4 = [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.31.196.1", "192.52.193.1",
    "192.88.99.1", "192.168.1.1", "192.175.48.1", "198.18.0.1", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
  ];
  const blockedV6 = [
    "::", "::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "2001:db8::1", "2002::1", "::a9fe:1", // 2001:db8::/32, 2002::/16, IPv4-compatible 169.254.0.1
    "2001::1", "64:ff9b::1", "100::1", "4000::1", "5f00::1", "3fff::1", // 2001::/23, NAT64, discard, unassigned, docs
    "2620:4f:8000::1", // AS112-v6
  ];
  const publicV6 = ["2606:4700:4700::1111"];

  it("accepts public IPv4", () => { for (const ip of publicV4) expect(isPublicUnicastIp(ip)).toBe(true); });
  it("rejects all special-use IPv4", () => { for (const ip of blockedV4) expect(isPublicUnicastIp(ip)).toBe(false); });
  it("rejects special-use + mapped IPv6", () => { for (const ip of blockedV6) expect(isPublicUnicastIp(ip)).toBe(false); });
  it("accepts public IPv6", () => { for (const ip of publicV6) expect(isPublicUnicastIp(ip)).toBe(true); });
  it("rejects non-IP strings", () => { expect(isPublicUnicastIp("example.com")).toBe(false); });
});
