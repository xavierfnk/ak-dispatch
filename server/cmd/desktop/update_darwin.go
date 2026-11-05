package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func currentInstallState() (string, bool, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false, err
	}
	installPath := filepath.Join(home, "Applications", "patient-dispatch-planner.app")
	executable, err := os.Executable()
	if err != nil {
		return installPath, false, nil
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	bundlePath := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
	return installPath, filepath.Clean(bundlePath) == filepath.Clean(installPath), nil
}

func startPlatformUpdate(download, signature, target, digest string) error {
	installPath, installed, err := currentInstallState()
	if err != nil {
		return err
	}
	if !installed || filepath.Clean(target) != filepath.Clean(installPath) {
		return fmt.Errorf("Place the app at %s before updating.", installPath)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	helper, err := os.CreateTemp(os.TempDir(), "pdp-update-*")
	if err != nil {
		return err
	}
	helperPath := helper.Name()
	if err := helper.Close(); err != nil {
		_ = os.Remove(helperPath)
		return err
	}
	if err := copyUpdateFile(self, helperPath, 0700); err != nil {
		_ = os.Remove(helperPath)
		return err
	}
	command := exec.Command(helperPath, "--apply-update", download, target, digest, signature, strconv.Itoa(os.Getpid()))
	if err := command.Start(); err != nil {
		_ = os.Remove(helperPath)
		return err
	}
	return nil
}

func runUpdateHelper(args []string) error {
	if len(args) != 5 {
		return errors.New("invalid update-helper arguments")
	}
	defer os.Remove(args[0])
	defer os.Remove(args[3])
	installPath, _, err := currentInstallState()
	if err != nil {
		return err
	}
	target, err := filepath.Abs(args[1])
	if err != nil || filepath.Clean(target) != filepath.Clean(installPath) {
		return errors.New("update target is not the per-user app installation")
	}
	if err := verifyUpdateSignature(args[0], args[2], args[3], updatePublicKey); err != nil {
		return err
	}
	pid, err := strconv.Atoi(args[4])
	if err != nil || pid <= 0 {
		return errors.New("invalid parent process ID")
	}
	if err := waitForDarwinProcessExit(pid); err != nil {
		return err
	}
	return replaceDarwinApp(args[0], target)
}

func waitForDarwinProcessExit(pid int) error {
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil && !errors.Is(err, syscall.EPERM) {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return errors.New("timed out waiting for the app to close")
}

func replaceDarwinApp(download, target string) error {
	extractDir, err := os.MkdirTemp("", "patient-dispatch-update-extract-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(extractDir)
	if output, err := exec.Command("/usr/bin/ditto", "-x", "-k", download, extractDir).CombinedOutput(); err != nil {
		return fmt.Errorf("could not unpack the macOS update: %s", strings.TrimSpace(string(output)))
	}
	newBundle := filepath.Join(extractDir, "patient-dispatch-planner.app")
	if info, err := os.Stat(filepath.Join(newBundle, "Contents", "MacOS", "patient-dispatch-planner")); err != nil || info.IsDir() {
		return errors.New("the macOS update archive does not contain the expected app bundle")
	}
	if output, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", newBundle).CombinedOutput(); err != nil {
		return fmt.Errorf("the downloaded macOS app failed code-signature verification: %s", strings.TrimSpace(string(output)))
	}

	stageDir, err := os.MkdirTemp(filepath.Dir(target), ".patient-dispatch-update-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stageDir)
	stagedBundle := filepath.Join(stageDir, filepath.Base(target))
	if output, err := exec.Command("/usr/bin/ditto", newBundle, stagedBundle).CombinedOutput(); err != nil {
		return fmt.Errorf("could not stage the macOS update: %s", strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", stagedBundle).CombinedOutput(); err != nil {
		return fmt.Errorf("the staged macOS app failed code-signature verification: %s", strings.TrimSpace(string(output)))
	}

	backupDir, err := os.MkdirTemp(filepath.Dir(target), ".patient-dispatch-backup-")
	if err != nil {
		return err
	}
	if err := os.Remove(backupDir); err != nil {
		return err
	}
	if err := os.Rename(target, backupDir); err != nil {
		return fmt.Errorf("could not move the installed app for replacement: %w", err)
	}
	if err := os.Rename(stagedBundle, target); err != nil {
		_ = os.Rename(backupDir, target)
		return fmt.Errorf("could not install the update: %w", err)
	}
	command := exec.Command("/usr/bin/open", "-a", target)
	if err := command.Start(); err != nil {
		_ = os.RemoveAll(target)
		_ = os.Rename(backupDir, target)
		return fmt.Errorf("could not restart the app: %w", err)
	}
	if err := os.RemoveAll(backupDir); err != nil {
		return fmt.Errorf("updated the app but could not remove its backup: %w", err)
	}
	return nil
}
