package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

type memoryCredentials struct {
	value string
	err   error
}

func (m *memoryCredentials) Get() (string, error) {
	if m.err != nil {
		return "", m.err
	}
	if m.value == "" {
		return "", keyring.ErrNotFound
	}
	return m.value, nil
}

func (m *memoryCredentials) Set(value string) error {
	m.value = value
	return nil
}

func (m *memoryCredentials) Delete() error {
	if m.value == "" {
		return keyring.ErrNotFound
	}
	m.value = ""
	return nil
}

func TestAPIKeySettingsUseCredentialStoreWithoutReturningSecret(t *testing.T) {
	credentials := &memoryCredentials{}
	service := newPlannerService(credentials)

	configured, err := service.GoogleAPIKeyConfigured()
	if err != nil || configured {
		t.Fatalf("empty key status = %t, %v; want false, nil", configured, err)
	}
	if err := service.SaveGoogleAPIKey("  user-key  "); err != nil {
		t.Fatal(err)
	}
	if credentials.value != "user-key" {
		t.Fatalf("stored key = %q, want trimmed key", credentials.value)
	}
	configured, err = service.GoogleAPIKeyConfigured()
	if err != nil || !configured {
		t.Fatalf("saved key status = %t, %v; want true, nil", configured, err)
	}
	if err := service.RemoveGoogleAPIKey(); err != nil {
		t.Fatal(err)
	}
	if configured, err := service.GoogleAPIKeyConfigured(); err != nil || configured {
		t.Fatalf("removed key status = %t, %v; want false, nil", configured, err)
	}
}

func TestAPIKeySettingsRejectInvalidInputAndHideCredentialErrors(t *testing.T) {
	credentials := &memoryCredentials{err: errors.New("private keychain detail")}
	service := newPlannerService(credentials)

	if err := service.SaveGoogleAPIKey("  "); err == nil {
		t.Fatal("blank API key was accepted")
	}
	if err := service.SaveGoogleAPIKey(strings.Repeat("k", 513)); err == nil {
		t.Fatal("oversized API key was accepted")
	}
	if _, err := service.GoogleAPIKeyConfigured(); err == nil || strings.Contains(err.Error(), "private keychain detail") {
		t.Fatalf("credential-store error was not safely mapped: %v", err)
	}
}
