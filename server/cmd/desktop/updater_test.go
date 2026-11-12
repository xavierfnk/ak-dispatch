package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		candidate string
		current   string
		want      bool
	}{
		{candidate: "v0.2.0", current: "v0.1.9", want: true},
		{candidate: "v0.1.0", current: "v0.1.0", want: false},
		{candidate: "v0.1.0", current: "v0.2.0", want: false},
		{candidate: "latest", current: "v0.1.0", want: false},
	}
	for _, test := range tests {
		if got := isNewerVersion(test.candidate, test.current); got != test.want {
			t.Errorf("isNewerVersion(%q, %q) = %t, want %t", test.candidate, test.current, got, test.want)
		}
	}
}

func TestReleaseAssetSelectsPlatformAndValidatesDigest(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	release := githubRelease{
		TagName: "v1.2.3",
		Assets: []githubAsset{
			{Name: "patient-dispatch-planner-linux-x64", BrowserDownloadURL: githubReleaseURL + "v1.2.3/patient-dispatch-planner-linux-x64", Digest: digest, Size: 10},
			{Name: "patient-dispatch-planner-windows-x64.exe", BrowserDownloadURL: githubReleaseURL + "v1.2.3/patient-dispatch-planner-windows-x64.exe", Digest: digest, Size: 10},
			{Name: "patient-dispatch-planner-macos-arm64.zip", BrowserDownloadURL: githubReleaseURL + "v1.2.3/patient-dispatch-planner-macos-arm64.zip", Digest: digest, Size: 20},
			{Name: "patient-dispatch-planner-macos-arm64.zip.sig", BrowserDownloadURL: githubReleaseURL + "v1.2.3/patient-dispatch-planner-macos-arm64.zip.sig", Digest: digest, Size: ed25519.SignatureSize},
		},
	}

	asset, err := releaseAsset(release, "darwin", "arm64")
	if err != nil || asset.Name != "patient-dispatch-planner-macos-arm64.zip" {
		t.Fatalf("arm64 release asset = %#v, %v", asset, err)
	}
	if signature, err := releaseSignatureAsset(release, asset); err != nil || signature.Name != asset.Name+".sig" {
		t.Fatalf("arm64 signature asset = %#v, %v", signature, err)
	}
	if _, err := releaseAsset(release, "darwin", "amd64"); err == nil {
		t.Fatal("missing macOS x64 asset was accepted")
	}
	if asset, err := releaseAsset(release, "linux", "amd64"); err != nil || asset.Name != "patient-dispatch-planner-linux-x64" {
		t.Fatalf("linux x64 release asset = %#v, %v", asset, err)
	}
	if _, err := releaseAsset(release, "linux", "arm64"); err == nil {
		t.Fatal("unsupported platform was accepted")
	}
}

func TestVerifyUpdateSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("release binary")
	digest := sha256.Sum256(content)
	signature := ed25519.Sign(privateKey, digest[:])
	directory := t.TempDir()
	assetPath := filepath.Join(directory, "app.exe")
	signaturePath := filepath.Join(directory, "app.exe.sig")
	if err := os.WriteFile(assetPath, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, signature, 0600); err != nil {
		t.Fatal(err)
	}
	encodedDigest := "sha256:" + hex.EncodeToString(digest[:])
	encodedKey := base64.StdEncoding.EncodeToString(publicKey)
	if err := verifyUpdateSignature(assetPath, encodedDigest, signaturePath, encodedKey); err != nil {
		t.Fatalf("valid signed update rejected: %v", err)
	}
	badSignature := append([]byte(nil), signature...)
	badSignature[0] ^= 0xff
	if err := os.WriteFile(signaturePath, badSignature, 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyUpdateSignature(assetPath, encodedDigest, signaturePath, encodedKey); err == nil {
		t.Fatal("update with an invalid publisher signature was accepted")
	}
	if err := os.WriteFile(signaturePath, signature, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(assetPath, []byte("tampered binary"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyUpdateSignature(assetPath, encodedDigest, signaturePath, encodedKey); err == nil {
		t.Fatal("tampered update was accepted")
	}
}

func TestReleaseAssetRejectsUnexpectedURLAndDigest(t *testing.T) {
	asset := githubAsset{
		Name:               "patient-dispatch-planner-windows-x64.exe",
		BrowserDownloadURL: "https://example.com/update.exe",
		Digest:             "sha256:" + strings.Repeat("a", 64),
		Size:               10,
	}
	if err := validateReleaseAsset("v1.2.3", asset); err == nil {
		t.Fatal("unexpected download host was accepted")
	}
	asset.BrowserDownloadURL = githubReleaseURL + "v1.2.3/update.exe"
	asset.Digest = "not-a-digest"
	if err := validateReleaseAsset("v1.2.3", asset); err == nil {
		t.Fatal("invalid asset digest was accepted")
	}
}
