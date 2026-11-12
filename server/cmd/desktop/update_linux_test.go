package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestLinuxHelperInstallsSignedUpdate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	target := filepath.Join(home, ".local", "bin", "patient-dispatch-planner")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old version"), 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(home, "restarted")
	content := []byte("#!/bin/sh\nprintf restarted > '" + marker + "'\n")
	download := filepath.Join(home, "download")
	signature := filepath.Join(home, "signature")
	if err := os.WriteFile(download, content, 0600); err != nil {
		t.Fatal(err)
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(content)
	if err := os.WriteFile(signature, ed25519.Sign(privateKey, digest[:]), 0600); err != nil {
		t.Fatal(err)
	}
	previousKey := updatePublicKey
	updatePublicKey = base64.StdEncoding.EncodeToString(publicKey)
	t.Cleanup(func() { updatePublicKey = previousKey })
	process := exec.Command("/bin/true")
	if err := process.Run(); err != nil {
		t.Fatal(err)
	}
	args := []string{download, target, "sha256:" + hex.EncodeToString(digest[:]), signature, strconv.Itoa(process.Process.Pid)}
	if err := runUpdateHelper(args); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if data, err := os.ReadFile(marker); err == nil && string(data) == "restarted" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("signed update did not restart")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLinuxHelperRejectsUnsignedUpdate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	target := filepath.Join(home, ".local", "bin", "patient-dispatch-planner")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old version"), 0700); err != nil {
		t.Fatal(err)
	}
	download := filepath.Join(home, "download")
	signature := filepath.Join(home, "signature")
	content := []byte("untrusted update")
	if err := os.WriteFile(download, content, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signature, make([]byte, ed25519.SignatureSize), 0600); err != nil {
		t.Fatal(err)
	}
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	previousKey := updatePublicKey
	updatePublicKey = base64.StdEncoding.EncodeToString(publicKey)
	t.Cleanup(func() { updatePublicKey = previousKey })
	digest := sha256.Sum256(content)
	args := []string{download, target, "sha256:" + hex.EncodeToString(digest[:]), signature, strconv.Itoa(os.Getpid())}
	if err := runUpdateHelper(args); err == nil {
		t.Fatal("unsigned update was accepted")
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "old version" {
		t.Fatalf("installed executable changed: %q, %v", data, err)
	}
}

func TestLinuxUpdateReplacesAndRestartsExecutable(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "patient-dispatch-planner")
	download := filepath.Join(dir, "download")
	marker := filepath.Join(dir, "restarted")
	if err := os.WriteFile(target, []byte("old version"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(download, []byte("#!/bin/sh\nprintf restarted > '"+marker+"'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceLinuxExecutable(download, target); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if data, err := os.ReadFile(marker); err == nil && string(data) == "restarted" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("updated executable did not restart")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("updated executable permissions: %v, %v", info, err)
	}
}

func TestLinuxUpdateRestoresPreviousExecutableWhenRestartFails(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "patient-dispatch-planner")
	download := filepath.Join(dir, "download")
	if err := os.WriteFile(target, []byte("old version"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(download, []byte("not an executable"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceLinuxExecutable(download, target); err == nil {
		t.Fatal("invalid executable was accepted")
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "old version" {
		t.Fatalf("previous executable not restored: %q, %v", data, err)
	}
}
