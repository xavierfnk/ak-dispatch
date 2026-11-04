package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/zalando/go-keyring"
	"patient-dispatch-planner/server/internal/dispatch"
	"patient-dispatch-planner/server/internal/googlemaps"
)

const (
	credentialService = "patient-dispatch-planner"
	credentialUser    = "google-maps-api-key"
	maxRouteElements  = 625
)

type credentialStore interface {
	Get() (string, error)
	Set(string) error
	Delete() error
}

type systemCredentialStore struct{}

func (systemCredentialStore) Get() (string, error) {
	return keyring.Get(credentialService, credentialUser)
}

func (systemCredentialStore) Set(value string) error {
	return keyring.Set(credentialService, credentialUser, value)
}

func (systemCredentialStore) Delete() error {
	return keyring.Delete(credentialService, credentialUser)
}

type PlannerService struct {
	credentials credentialStore
	app         *application.App
}

func NewPlannerService() *PlannerService {
	return &PlannerService{credentials: systemCredentialStore{}}
}

func newPlannerService(credentials credentialStore) *PlannerService {
	return &PlannerService{credentials: credentials}
}

func (s *PlannerService) GoogleAPIKeyConfigured() (bool, error) {
	apiKey, err := s.credentials.Get()
	if errors.Is(err, keyring.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, errors.New("Could not access the system credential store.")
	}
	return strings.TrimSpace(apiKey) != "", nil
}

func (s *PlannerService) SaveGoogleAPIKey(apiKey string) error {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" || len(apiKey) > 512 {
		return errors.New("Enter a valid Google Maps API key.")
	}
	if err := s.credentials.Set(apiKey); err != nil {
		return errors.New("Could not save the key in the system credential store.")
	}
	return nil
}

func (s *PlannerService) RemoveGoogleAPIKey() error {
	if err := s.credentials.Delete(); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return errors.New("Could not remove the key from the system credential store.")
	}
	return nil
}

func (s *PlannerService) Calculate(request dispatch.Request) (dispatch.Response, error) {
	apiKey, err := s.credentials.Get()
	if err != nil || strings.TrimSpace(apiKey) == "" {
		return dispatch.Response{}, errors.New("Add a Google Maps API key in Settings before calculating routes.")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return dispatch.CalculateWithProvider(ctx, request, googlemaps.NewClient(apiKey), maxRouteElements)
}
