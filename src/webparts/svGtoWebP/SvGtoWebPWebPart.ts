import * as React from "react";
import * as ReactDom from "react-dom";
import { BaseClientSideWebPart } from "@microsoft/sp-webpart-base";
import SvgToWebp from "./components/SvGtoWebP";

export interface ISvgToWebpWebPartProps {}

export default class SvgToWebpWebPart extends BaseClientSideWebPart<ISvgToWebpWebPartProps> {
  public render(): void {
    const element = React.createElement(SvgToWebp);
    ReactDom.render(element, this.domElement);
  }

  protected onDispose(): void {
    ReactDom.unmountComponentAtNode(this.domElement);
  }
}
