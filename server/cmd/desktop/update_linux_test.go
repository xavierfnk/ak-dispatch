package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
