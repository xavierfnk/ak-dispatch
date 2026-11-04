package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var frontend embed.FS

func main() {
	app := application.New(application.Options{
		Name:        "Patient Dispatch Planner",
		Description: "Local patient cohort planning",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(frontend),
		},
		Services: []application.Service{
			application.NewService(NewPlannerService()),
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Répartition des patientes",
		Width:     1440,
		Height:    960,
		MinWidth:  1000,
		MinHeight: 700,
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
