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
	installPath := filepath.Join(home, ".local", "bin", "patient-dispatch-planner")
	executable, err := os.Executable()
	if err != nil {
		return installPath, false, nil
	}
	// Resolve both paths so a symlinked home directory remains usable.
	actual, err := filepath.EvalSymlinks(installPath)
	if err != nil {
		return installPath, false, nil
	}
	return installPath, filepath.Clean(executable) == filepath.Clean(actual), nil
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
	helper, err := os.CreateTemp(filepath.Dir(target), ".patient-dispatch-helper-*")
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
	if self, err := os.Executable(); err == nil && strings.HasPrefix(filepath.Base(self), ".patient-dispatch-helper-") {
		defer os.Remove(self)
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
	deadline := time.Now().Add(2 * time.Minute)
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if err != nil && !errors.Is(err, syscall.EPERM) {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("timed out waiting for the app to close")
		}
		time.Sleep(200 * time.Millisecond)
	}
	return replaceLinuxExecutable(args[0], target)
}

func replaceLinuxExecutable(download, target string) error {
	stage, err := os.CreateTemp(filepath.Dir(target), ".patient-dispatch-update-*")
	if err != nil {
		return err
	}
	stagePath := stage.Name()
	defer os.Remove(stagePath)
	if err := stage.Close(); err != nil {
		return err
	}
	if err := copyUpdateFile(download, stagePath, 0700); err != nil {
		return err
	}
	backup, err := os.CreateTemp(filepath.Dir(target), ".patient-dispatch-backup-*")
	if err != nil {
		return err
	}
	backupPath := backup.Name()
	if err := backup.Close(); err != nil {
		_ = os.Remove(backupPath)
		return err
	}
	if err := os.Rename(target, backupPath); err != nil {
		_ = os.Remove(backupPath)
		return err
	}
	if err := os.Rename(stagePath, target); err != nil {
		_ = os.Rename(backupPath, target)
		return err
	}
	if err := exec.Command(target).Start(); err != nil {
		_ = os.Remove(target)
		_ = os.Rename(backupPath, target)
		return fmt.Errorf("updated the app but could not restart it: %w", err)
	}
	return os.Remove(backupPath)
}
