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

	"golang.org/x/sys/windows"
)

func currentInstallState() (string, bool, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		var err error
		localAppData, err = os.UserCacheDir()
		if err != nil {
			return "", false, err
		}
	}
	installPath := filepath.Join(localAppData, "Programs", "Patient Dispatch Planner", "patient-dispatch-planner.exe")
	executable, err := os.Executable()
	if err != nil {
		return installPath, false, nil
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return installPath, false, nil
	}
	return installPath, strings.EqualFold(filepath.Clean(executable), filepath.Clean(installPath)), nil
}

func startPlatformUpdate(download, signature, target, digest string) error {
	installPath, installed, err := currentInstallState()
	if err != nil {
		return err
	}
	if !installed || !strings.EqualFold(filepath.Clean(target), filepath.Clean(installPath)) {
		return fmt.Errorf("Place the app at %s before updating.", installPath)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	helper, err := os.CreateTemp(os.TempDir(), "pdp-update-*.exe")
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
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
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
	if err != nil || !strings.EqualFold(filepath.Clean(target), filepath.Clean(installPath)) {
		return errors.New("update target is not the per-user app installation")
	}
	if err := verifyUpdateSignature(args[0], args[2], args[3], updatePublicKey); err != nil {
		return err
	}
	pid, err := strconv.Atoi(args[4])
	if err != nil || pid <= 0 {
		return errors.New("invalid parent process ID")
	}
	if err := waitForWindowsProcessExit(uint32(pid)); err != nil {
		return err
	}
	return replaceWindowsExecutable(args[0], target)
}

func waitForWindowsProcessExit(pid uint32) error {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	result, err := windows.WaitForSingleObject(process, 120000)
	if err != nil {
		return err
	}
	if result == uint32(windows.WAIT_TIMEOUT) {
		return errors.New("timed out waiting for the app to close")
	}
	return nil
}

func replaceWindowsExecutable(download, target string) error {
	newFile, err := os.CreateTemp(filepath.Dir(target), ".patient-dispatch-update-*.exe")
	if err != nil {
		return err
	}
	newPath := newFile.Name()
	if err := newFile.Close(); err != nil {
		_ = os.Remove(newPath)
		return err
	}
	if err := copyUpdateFile(download, newPath, 0700); err != nil {
		_ = os.Remove(newPath)
		return err
	}
	backup, err := os.CreateTemp(filepath.Dir(target), ".patient-dispatch-backup-*.exe")
	if err != nil {
		_ = os.Remove(newPath)
		return err
	}
	backupPath := backup.Name()
	if err := backup.Close(); err != nil {
		_ = os.Remove(newPath)
		_ = os.Remove(backupPath)
		return err
	}
	if err := os.Remove(backupPath); err != nil {
		_ = os.Remove(newPath)
		return err
	}
	if err := os.Rename(target, backupPath); err != nil {
		_ = os.Remove(newPath)
		return err
	}
	if err := os.Rename(newPath, target); err != nil {
		_ = os.Rename(backupPath, target)
		return err
	}
	command := exec.Command(target)
	if err := command.Start(); err != nil {
		_ = os.Remove(target)
		_ = os.Rename(backupPath, target)
		return fmt.Errorf("updated the app but could not restart it: %w", err)
	}
	if err := os.Remove(backupPath); err != nil {
		return fmt.Errorf("updated the app but could not remove its backup: %w", err)
	}
	return nil
}
