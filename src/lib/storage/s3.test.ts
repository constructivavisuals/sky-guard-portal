import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { amzDates, presignUrl, signedHeaders, type S3Config } from "./s3.ts";

// Podpis se nedá „skoro“ spočítat: buď sedí na bajt, nebo úložiště
// odpoví 403 a nedá vědět proč. Proto se měří proti ZVEŘEJNĚNÉMU
// vektoru z dokumentace AWS, ne proti našemu vlastnímu výstupu —
// test, který porovnává kód sám se sebou, projde i s chybou v obou.
const AWS_PRIKLAD: S3Config = {
  endpoint: "s3.amazonaws.com",
  region: "us-east-1",
  bucket: "examplebucket",
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("presignUrl", () => {
  it("dá týž podpis jako příklad v dokumentaci AWS", () => {
    const url = presignUrl(AWS_PRIKLAD, {
      method: "GET",
      key: "test.txt",
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });

    assert.match(
      url,
      /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
    );
  });

  it("podepisuje JEN host, ať relayi neuškodí vlastní Content-Type", () => {
    const url = presignUrl(AWS_PRIKLAD, {
      method: "PUT",
      key: "a/b.mp4",
      expiresIn: 600,
      now: new Date("2026-08-28T12:00:00Z"),
    });
    assert.match(url, /X-Amz-SignedHeaders=host(&|$)/);
  });

  it("virtual-hosted dá bucket do jména, path-style do cesty", () => {
    const spolecne = { method: "GET" as const, key: "k.mp4", expiresIn: 60 };
    assert.match(presignUrl(AWS_PRIKLAD, spolecne), /^https:\/\/examplebucket\.s3\.amazonaws\.com\/k\.mp4\?/);
    assert.match(
      presignUrl({ ...AWS_PRIKLAD, pathStyle: true }, spolecne),
      /^https:\/\/s3\.amazonaws\.com\/examplebucket\/k\.mp4\?/,
    );
  });

  it("kóduje znaky, na kterých encodeURIComponent selhává", () => {
    // `!'()*` nechává encodeURIComponent být; S3 je čeká zakódované.
    const url = presignUrl(AWS_PRIKLAD, {
      method: "GET",
      key: "a b!'()*.mp4",
      expiresIn: 60,
    });
    assert.ok(!/[!'()*]/.test(new URL(url).pathname), url);
    assert.match(url, /%20/);
  });

  it("lomítka v klíči zůstávají oddělovači", () => {
    const url = presignUrl(AWS_PRIKLAD, {
      method: "GET",
      key: "site/cam/2026/08/27/103453-motion.mp4",
      expiresIn: 60,
    });
    assert.equal(new URL(url).pathname, "/site/cam/2026/08/27/103453-motion.mp4");
  });
});

describe("signedHeaders", () => {
  it("podepíše prázdné tělo otiskem prázdného řetězce", () => {
    const h = signedHeaders(AWS_PRIKLAD, { method: "HEAD", key: "test.txt" });
    assert.equal(
      h["x-amz-content-sha256"],
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
  });

  it("tělo se podepisuje svým otiskem, ne prázdným", () => {
    const h = signedHeaders(AWS_PRIKLAD, {
      method: "POST",
      key: "",
      query: "delete=",
      body: Buffer.from("<Delete/>"),
    });
    assert.notEqual(
      h["x-amz-content-sha256"],
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hlavičky navíc jdou do podpisu seřazené a malými písmeny", () => {
    const h = signedHeaders(AWS_PRIKLAD, {
      method: "POST",
      key: "",
      extra: { "Content-MD5": "abc==" },
    });
    assert.match(h.Authorization, /SignedHeaders=content-md5;host;x-amz-content-sha256;x-amz-date/);
  });
});

describe("amzDates", () => {
  it("dá tvar, jaký SigV4 čeká", () => {
    const { amzDate, datum } = amzDates(new Date("2026-08-28T18:57:00.123Z"));
    assert.equal(amzDate, "20260828T185700Z");
    assert.equal(datum, "20260828");
  });
});
